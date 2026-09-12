@echo off
rem ==========================================================================
rem  Vellum 一键更新 VPS（Windows 端）
rem
rem  用法（在这个仓库根目录下）：
rem      deploy\update-vps.cmd
rem
rem  做四件事：
rem    1. 把当前工作区打包成 tar（排除 .git / node_modules / data / 截图 / 私钥）
rem    2. scp 传到服务器
rem    3. 调服务器上的 deploy/deploy.sh：备份 → 解包 → 重建镜像 → 重启 → 自检
rem    4. 打印自检结果
rem
rem  服务器上的 .env 和 data/ 不会被覆盖（打包时就没带，部署脚本也只覆盖同名文件）。
rem  回滚：部署脚本会在 /root/vellum-backup-<时间戳>.tar.gz 留一份改动前的代码，
rem        解回去再 docker compose up -d --build 即可。
rem ==========================================================================
setlocal
chcp 65001 >nul

set "KEY=%~dp0..\key-1o59pu0l\key-1o59pu0l.pem"
set "HOST=root@69.63.223.0"
set "ARCHIVE=%TEMP%\vellum-update.tar.gz"

echo.
echo [1/4] 打包当前工作区...
rem 不打包的三类东西：
rem   - 运行数据：.git / node_modules / data / screenshots / 私钥 / .env
rem   - 服务器专属的 Caddy 部署配置。本机这几份还是「IP + 自签证书」的旧版，
rem     传上去会把线上正在用的「域名 + 自动 HTTPS」覆盖掉，HTTPS 当场失效。
rem     （服务器上那份是就地改过的，仓库里没有对应版本，所以只能排除。）
tar -czf "%ARCHIVE%" ^
  --exclude=.git --exclude=node_modules --exclude=data --exclude=screenshots ^
  --exclude=key-1o59pu0l --exclude=.env --exclude="*.tar.gz" ^
  --exclude=./deploy/docker-compose.ip8443.yml ^
  --exclude=./deploy/Caddyfile.ip8443 --exclude=./deploy/Caddyfile.ip8443-domain ^
  -C "%~dp0.." .
if errorlevel 1 goto :fail
for %%A in ("%ARCHIVE%") do echo       包大小 %%~zA 字节

echo [2/4] 上传到 %HOST% ...
scp -i "%KEY%" -o StrictHostKeyChecking=no "%ARCHIVE%" %HOST%:/root/vellum-update.tar.gz
if errorlevel 1 goto :fail

echo [3/4] 在服务器上部署...
ssh -i "%KEY%" -o StrictHostKeyChecking=no %HOST% "mkdir -p /opt/vellum && tar -xzf /root/vellum-update.tar.gz -C /opt/vellum && rm -f /root/vellum-update.tar.gz && bash /opt/vellum/deploy/deploy.sh"
if errorlevel 1 goto :fail

echo [4/4] 完成。
goto :eof

:fail
echo.
echo *** 失败了，看上面的输出。服务器上的改动可以按 deploy\deploy.sh 里的备份回滚。***
exit /b 1
