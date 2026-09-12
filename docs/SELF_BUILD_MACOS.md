# macOS 自用版本

自用分支为 `personal/macos`。`origin` 指向 Eric-Terminal 的 fork，`upstream` 指向原项目。原来的 `feat/macos-smappservice` 分支保留，不跟随自用版本重写历史。

此分支基于上游 2.5.4 开发线。macOS 13 及以上使用 SMAppService，由「系统设置 → 通用 → 登录项与扩展」批准后台服务；Touch ID 是否出现由系统决定。应用名称和配置目录沿用原版，可直接替换 `/Applications/Clash Verge.app`。

## 构建

需要项目指定的 Rust、pnpm，以及钥匙串中可用的 Apple Development 或 Developer ID Application 签名证书。多个证书并存时，用 `APPLE_SIGNING_IDENTITY` 指定原先使用的证书。

```sh
bash scripts/build-macos-personal.sh
```

脚本安装锁定依赖、更新包内内核和服务资源，构建经过优化的 Release App 并验证签名。不生成 DMG、updater 包和调试符号。产物位于 `target/release/bundle/macos/Clash Verge.app`。

开发证书可用于本机运行和系统服务批准；这不等于完成了对外发行所需的 Developer ID 签名和公证。

## 跟随上游

先提交本地修改，再在自用分支执行：

```sh
git switch personal/macos
git fetch upstream --prune --tags
git branch "backup/personal-macos-$(date +%Y%m%d-%H%M%S)"
git rebase --gpg-sign upstream/dev
```

如果要改为跟随正式发布，用相应版本标签替换 `upstream/dev`；目标版本必须包含本分支依赖的服务接口。解决冲突后需要检查服务安装、批准、启动和内核更新相关改动，不能只依据 Git 自动合并成功判断兼容性。

```sh
pnpm test
pnpm typecheck
pnpm lint
cargo test -p clash-verge --lib --locked
cargo clippy --all-targets --all-features --locked -- -D warnings
bash scripts/build-macos-personal.sh
git push --force-with-lease origin personal/macos
```

`--force-with-lease` 只用于自己 rebase 后的分支。如果远端出现其他提交，先检查差异。不要强推原功能 PR 分支。

## 替换应用

先完成新 App 的构建与签名校验，再退出 Clash Verge，替换 `/Applications/Clash Verge.app` 并启动。退出、替换和启动需要在本机连续完成：退出代理可能中断网络，不能依赖后续远程指令来启动应用。应用必须放在 `/Applications`：新版服务安装器会检查内核来源位置。继续使用同一签名证书，并在需要时到系统设置批准后台服务。更新包内服务后，可使用应用现有的服务修复入口重新注册。

如果 Homebrew 仍记录着原版安装，执行 `brew pin --cask clash-verge-rev`，阻止 `brew upgrade` 覆盖自用版本。已经替换 App 后不要执行 `brew uninstall`，它仍会删除 `/Applications/Clash Verge.app`；`--zap` 还会清除配置。锁定保留的只是 Homebrew 安装记录，应用由自用构建更新。

后台入口先以系统身份调用原安装器的 `--install-core`，准备包内的两个内核副本，再执行原服务。服务 IPC、可信路径校验和内核副本的权限规则保持上游实现。

应用内的整包更新与自动检查已停用。macOS 正式 App 的内核也随整包更新，避免单独替换签名资源导致 SMAppService 在下次注册时拒绝应用。订阅更新不受影响。

## 清理编译缓存

确认新 App 已复制到 `/Applications` 且运行正常后，可以删除仓库下的 `target` 和 `dist`。这会同时删除尚在构建目录里的 App 产物，下次构建需要重新编译。
