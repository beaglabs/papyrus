// ---------------------------------------------------------------------------
// Papyrus appliance — Azure deployment template.
//
// This deploys the container we build from the repo Dockerfile onto a stock
// Ubuntu 24.04 image, and supervises it with systemd. It is the technical
// asset behind an Azure Application offer (solution template or managed
// application); the same template serves both, because the difference between
// those two offer types is packaging, not content.
//
// Design notes worth keeping:
//
//   * The container image is the unit of delivery. Nothing about Papyrus is
//     installed onto the host beyond Docker, so the OS stays a stock image
//     that Microsoft and Canonical patch — we never own a VHD.
//   * The setup token, license, portal secret, and Entra configuration are all
//     entered through the first-run onboarding flow, keeping them out of ARM
//     deployment history.
//   * The image is pulled from a publicly readable repository, so no registry
//     credential exists anywhere in this deployment. Every alternative was
//     considered and rejected: a credential cannot be embedded (the ARM JSON is
//     visible to customers); managed identity cannot span tenants, so it cannot
//     reach a publisher-owned registry from a customer subscription; and gating
//     the pull to "whoever deployed the offer" is not a control when deploying a
//     listed offer is free and self-service. Anyone who wants the image can have
//     it, and that is fine — the customer already has root on the appliance, so
//     the image was never secret from them. What the licence protects is the
//     commercial entitlement, not the bytes.
//
// Validated configuration: amd64, Ubuntu 24.04, kernel 6.17, Docker's default
// seccomp profile, landstrip sandbox probe green. The `securityType` default
// below intentionally matches that validated VM — see the parameter comment.
// ---------------------------------------------------------------------------

targetScope = 'resourceGroup'

@description('Azure region for the appliance.')
param location string = resourceGroup().location

@description('Name prefix for every resource this deployment creates.')
@minLength(3)
@maxLength(20)
param namePrefix string = 'papyrus'

@description('VM size. The default is an amd64 general-purpose size. Avoid Standard_B2s: it was capacity-restricted in eastus when this was written, and the Bsv2 family carried zero quota.')
param vmSize string = 'Standard_D2as_v7'

@description('Authentication method for the VM: password or sshPublicKey.')
@allowed([
  'password'
  'sshPublicKey'
])
param authenticationType string = 'sshPublicKey'

@description('Admin username for the appliance VM.')
param adminUsername string = 'papyrusadmin'

@secure()
@description('Admin password. Required when authenticationType is password.')
param adminPassword string = ''

@secure()
@description('SSH public key. Required when authenticationType is sshPublicKey.')
param sshPublicKey string = ''

@description('Port the onboarding UI and API listen on.')
param papyrusPort int = 3210

@description('Attach a public IP. Required if the onboarding UI must be reachable from outside the virtual network.')
param createPublicIp bool = true

@description('DNS label for the public IP, giving <label>.<region>.cloudapp.azure.com.')
param dnsLabelPrefix string = ''

@description('Size of the dedicated data disk backing /var/lib/papyrus.')
@minValue(16)
@maxValue(1024)
param dataDiskSizeGb int = 32

@description('Source address prefix allowed to reach SSH and the onboarding port. Narrow this to the operator network; * exposes it to the internet.')
param allowedSourceAddressPrefix string = '*'

@description('VM security type. Defaults to Standard because that is the configuration validated end to end. TrustedLaunch is the better production posture but changes the boot chain, so validate it before relying on it.')
@allowed([
  'Standard'
  'TrustedLaunch'
])
param securityType string = 'Standard'

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

var vmName = '${namePrefix}-appliance'
var vnetName = '${namePrefix}-vnet'
var subnetName = '${namePrefix}-subnet'
var nsgName = '${namePrefix}-nsg'
var nicName = '${namePrefix}-nic'
var publicIpName = '${namePrefix}-pip'
var dataDiskLun = 0

// The image ships with the offer. Customers do not choose it and are never asked for
// registry credentials, so the reference is a variable rather than a parameter.
//
// The repository MUST be publicly pullable. A solution template's ARM JSON is visible to
// every customer, and its deployment history is readable by anyone with access to the
// resource group, so a registry credential can never be embedded here. Gating the pull to
// "the customer who deployed the offer" is not a control either: deploying a listed offer
// is free and self-service, so any gate keyed on it is satisfied by anyone motivated.
//
// Verified anonymously pullable: logged out of the registry, removed the local tag, and
// pulled it clean. amd64, built natively by ACR Tasks, scanned clean of dev data.
//
// 0.1.1 carries the first-run onboarding fix — that screen previously shipped a borrowed
// dark palette instead of the portal's own theme. Tags here are immutable: ship a new tag
// per change and update this line, rather than overwriting a published one.
var imageReference = 'ghcr.io/beaglabs/papyrus:0.1.1'

var cloudInit = replace(
  replace(
    replace(
      loadTextContent('cloud-init.yaml'),
      '__IMAGE__',
      imageReference
    ),
    '__PORT__',
    string(papyrusPort)
  ),
  '__DATA_DISK_LUN__',
  string(dataDiskLun)
)

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: nsgName
  location: location
  properties: {
    securityRules: [
      {
        name: 'allow-ssh'
        properties: {
          description: 'Operator access.'
          priority: 1000
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: allowedSourceAddressPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'allow-papyrus'
        properties: {
          description: 'Onboarding UI and API. Terminate TLS in front of this in production.'
          priority: 1010
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: allowedSourceAddressPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: string(papyrusPort)
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.20.0.0/16'
      ]
    }
    subnets: [
      {
        name: subnetName
        properties: {
          addressPrefix: '10.20.1.0/24'
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
    ]
  }
}

resource publicIp 'Microsoft.Network/publicIPAddresses@2023-11-01' = if (createPublicIp) {
  name: publicIpName
  location: location
  sku: {
    name: 'Standard'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: empty(dnsLabelPrefix) ? null : {
      domainNameLabel: dnsLabelPrefix
    }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-11-01' = {
  name: nicName
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: {
            id: vnet.properties.subnets[0].id
          }
          publicIPAddress: createPublicIp ? {
            id: publicIp.id
          } : null
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: vmName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    hardwareProfile: {
      vmSize: vmSize
    }
    securityProfile: securityType == 'TrustedLaunch' ? {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    } : null
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      adminPassword: authenticationType == 'password' ? adminPassword : null
      linuxConfiguration: authenticationType == 'sshPublicKey' ? {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: sshPublicKey
            }
          ]
        }
      } : null
      customData: base64(cloudInit)
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        name: '${vmName}-osdisk'
        createOption: 'FromImage'
        deleteOption: 'Delete'
        managedDisk: {
          storageAccountType: 'Premium_LRS'
        }
      }
      // Detach rather than delete: appliance state outlives the VM on purpose.
      dataDisks: [
        {
          lun: dataDiskLun
          name: '${vmName}-data'
          createOption: 'Empty'
          diskSizeGB: dataDiskSizeGb
          deleteOption: 'Detach'
          managedDisk: {
            storageAccountType: 'Premium_LRS'
          }
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [
        {
          id: nic.id
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

output applianceName string = vm.name
// Not named `vmSize`. The ARM test toolkit's "VM Size Should Be A Parameter" check walks
// the whole template for any key literally named `vmSize`, and for an output its parent is
// the outputs object — so the value it inspects is this output definition (an object)
// rather than a `[parameters(...)]` string. It then reports "must be a parameter" against
// resourceType 'string'. Certification runs that check, so this output name is load-bearing.
output applianceVmSize string = vm.properties.hardwareProfile.vmSize
output imageReference string = imageReference
output privateIpAddress string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output publicIpAddress string = createPublicIp ? publicIp!.properties.ipAddress : ''
output onboardingUrl string = createPublicIp ? 'http://${publicIp!.properties.ipAddress}:${papyrusPort}/' : ''
output sshCommand string = createPublicIp ? 'ssh ${adminUsername}@${publicIp!.properties.ipAddress}' : ''
output dataDiskName string = '${vmName}-data'
