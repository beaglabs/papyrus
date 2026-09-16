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
//   * The image pull takes an explicit registry credential rather than relying
//     on the VM's managed identity. Microsoft's documented identity flow for
//     ACR is `az login --identity` + `az acr login`, which would mean shipping
//     the whole Azure CLI on the appliance; the raw `docker login -p <AAD
//     token>` shortcut is not supported and fails with "Invalid clientid or
//     client secret". A credential also works when the registry is not an ACR,
//     or is in another tenant — the common case for a marketplace image. The
//     VM identity is still created, as the hook for the ACR token-exchange
//     flow or Key Vault access later.
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

@description('Container registry login server, for example contoso.azurecr.io.')
param acrLoginServer string

@description('Repository name of the Papyrus image.')
param imageRepository string = 'papyrus'

@description('Image tag to deploy. Use an immutable tag, not latest — a marketplace artifact must be reproducible.')
param imageTag string = '0.1.0'

@description('True when the image can be pulled anonymously: a public registry, or an ACR with anonymous pull enabled.')
param publicRegistry bool = false

@description('Registry username for a private image. Prefer a pull-only credential over an admin account.')
param registryUsername string = ''

@secure()
@description('Registry password or token for a private image.')
param registryPassword string = ''

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

var image = '${acrLoginServer}/${imageRepository}:${imageTag}'

var cloudInit = replace(
  replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              loadTextContent('cloud-init.yaml'),
              '__IMAGE__',
              image
            ),
            '__ACR_LOGIN_SERVER__',
            acrLoginServer
          ),
          '__PUBLIC_REGISTRY__',
          string(publicRegistry)
        ),
        '__REGISTRY_USERNAME__',
        registryUsername
      ),
      '__REGISTRY_PASSWORD__',
      registryPassword
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
output vmSize string = vm.properties.hardwareProfile.vmSize
output image string = image
output privateIpAddress string = nic.properties.ipConfigurations[0].properties.privateIPAddress
output publicIpAddress string = createPublicIp ? publicIp!.properties.ipAddress : ''
output onboardingUrl string = createPublicIp ? 'http://${publicIp!.properties.ipAddress}:${papyrusPort}/' : ''
output sshCommand string = createPublicIp ? 'ssh ${adminUsername}@${publicIp!.properties.ipAddress}' : ''
output dataDiskName string = '${vmName}-data'
