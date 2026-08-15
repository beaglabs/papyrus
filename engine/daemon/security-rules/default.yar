rule Papyrus_Suspicious_PowerShell_Download
{
  meta:
    description = "Detects common PowerShell download and execution patterns in staged content"
    severity = "high"
  strings:
    $a = "DownloadString(" ascii wide nocase
    $b = "Invoke-WebRequest" ascii wide nocase
    $c = "-EncodedCommand" ascii wide nocase
    $d = "IEX(" ascii wide nocase
  condition:
    2 of them
}

rule Papyrus_Office_AutoExecution_Markers
{
  meta:
    description = "Detects auto-executing Office macro markers in staged content"
    severity = "moderate"
  strings:
    $a = "AutoOpen" ascii wide nocase
    $b = "Document_Open" ascii wide nocase
    $c = "CreateObject(\"WScript.Shell\")" ascii wide nocase
  condition:
    any of them
}
