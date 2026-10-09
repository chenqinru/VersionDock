# 插件与 Desktop 的搁置互通

插件与 Desktop 都更新到支持共享搁置存储的版本后，同一个本地 Git 工作目录共用一份搁置记录。任一端创建或删除记录，另一端刷新搁置列表即可看到结果；两端均可完整恢复或按文件恢复对方创建的记录。恢复默认保留记录，插件的“恢复并删除”仍由已有选项控制。

普通仓库的存储位置为 `.git/versiondock/shelves/`，使用 `git rev-parse --absolute-git-dir` 定位实际 Git 目录。子模块和 linked worktree 使用自己的 Git 目录；独立 clone 和不同 worktree 不共享搁置。该目录不会进入工作区的待提交文件，也不会随 Git push 发送到远端。

## 存储协议

- 两端只写 `shelves.json`，格式为 `{ shelves, migratedSources?, deletedIds? }`；搁置条目使用 `id`、`name`、`date`、`branch`、`files: [{path, status}]`、`patchFile` 和可选的 `changelistAssignments`、`binaryFiles`。
- 文本、已跟踪二进制文件以及 Desktop 新建记录使用 Git 补丁；插件的独立附件使用 `binaryFiles: [{repoRelPath, storeName, mode?, kind?}]`。`kind` 为 `file` 或 `symlink`，省略时按普通文件处理。符号链接附件保存目标的原始字节，Unix 上恢复普通文件时保留权限。
- 按文件恢复提取补丁的原始字节，文件名按字面值匹配，避免把 `[]`、`*`、`?` 当成 glob。
- 读列表、迁移、读差异、创建、恢复、重命名和删除共用 `.lock` 目录锁，原子创建目录取得锁。等待最多 5 秒，超时报告存储忙，不抢占或自动删除锁。元数据通过独立临时文件原子替换。进程异常退出若留下锁，须确认占用进程已退出后手工清理。
- 损坏的元数据报告错误，不以空列表覆盖；恢复独立附件前检查源文件、目标路径及是否存在目标文件，拒绝路径越界、符号链接父目录和覆盖已有文件。

## 旧数据迁移

首次访问时将发现的旧插件及 Desktop 存储合并到共享目录，即使共享列表已有记录也执行迁移。插件读取自身 IDE 的旧 `globalStorage` 和标准 Desktop 配置目录；Desktop 读取自身旧配置目录及原有 IDE 目录候选。自定义或未被发现的旧存储在所属客户端首次访问该仓库时迁移。

迁移保留旧目录，完整复制补丁、二进制和符号链接附件；按 ID 去重，并给旧 App 导入的缺少附件的记录补回原插件附件。支持旧 `index.json`、`createdAt`、字符串文件列表及补丁副本曾被重命名的情况。缺失或不可读的迁移内容报告错误，避免悄悄留下不完整记录。

`migratedSources` 防止反复导入同一来源；`deletedIds` 防止随后发现的另一旧副本让已删除记录重新出现。完成迁移后旧版本客户端在旧目录上的新增、修改和删除不会同步，互通要求两端均使用新版。

## 验证

插件服务使用真实临时 Git 仓库测试；指定独立 Desktop checkout 可通过其 Rust 测试进程交叉验证，两端无源码或运行时依赖：

```sh
npm run test:shelves
npm run test:shelves -- --desktop /path/to/VersionDockDesktop
```

覆盖双向创建、列表、差异、完整和部分恢复、删除、二进制原始字节、可执行权限、非 UTF-8 符号链接目标、旧数据合并、并发写锁、目标防覆盖和 worktree 隔离。该测试验证真实仓库与两端后端，不代替 VS Code/Tauri 界面运行或安装包验收。Windows 符号链接受系统权限限制，当前跨端测试在 macOS 执行。
