# 开机自启注册脚本（Windows）
# 用法：右键"使用 PowerShell 运行"，或在 PowerShell 中执行：
#   powershell -ExecutionPolicy Bypass -File .\register-autostart.ps1
# 作用：注册一个计划任务，开机后自动启动作业工作台服务（node server.js）
# 取消自启：schtasks /Delete /TN "HWBench Autostart" /F

$ErrorActionPreference = "Stop"

# 定位 Node 与项目目录
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    # 常见安装位置兜底
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path $p) { $node = $p; break }
    }
}
if (-not $node) { Write-Host "✗ 未找到 Node.js，请先安装" -ForegroundColor Red; exit 1 }

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs = Join-Path $appDir "server.js"
if (-not (Test-Path $serverJs)) { Write-Host "✗ 未找到 $serverJs" -ForegroundColor Red; exit 1 }

$taskName = "HWBench Autostart"
$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$serverJs`"" -WorkingDirectory $appDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "✓ 已注册开机自启计划任务：$taskName" -ForegroundColor Green
Write-Host "  启动命令：$node `"$serverJs`"" 
Write-Host "  平板访问：https://<电脑局域网IP>:8443（首次需信任证书）"
Write-Host ""
Write-Host "现在就启动一次服务吗？关闭此窗口即停止。"
$ans = Read-Host "输入 y 启动，其他键退出"
if ($ans -eq "y" -or $ans -eq "Y") {
    Start-Process -FilePath $node -ArgumentList "`"$serverJs`"" -WorkingDirectory $appDir
    Start-Sleep -Seconds 2
    Write-Host "服务已启动：http://127.0.0.1:8900 （关闭 node 窗口或重启后由计划任务拉起）"
}
