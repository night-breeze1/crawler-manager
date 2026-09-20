# 爬虫项目管理工具

一个用于管理多个爬虫项目（数美、顶象、小红书等）的本地 Web 工具。每个项目独立做版本管理，可切换版本浏览源码，并维护"思路流程"文档便于下次迭代参考。

## 功能

- **项目管理**：新增 / 编辑 / 删除爬虫项目，支持标签与描述
- **项目重命名**：编辑项目时可修改名称，自动重命名目录与所有引用
- **文件夹上传**：新增项目或新版本时，直接选择整个文件夹批量上传
- **多版本管理**：每个项目可上传多个版本（v1.0.0、v1.1.0 ...），完整副本存储，可一键切换"当前版本"
- **版本说明编辑**：随时修改任一版本的说明文字
- **版本源码替换**：对已有版本重新上传文件夹，覆盖该版本源码
- **从已有版本复制创建新版本**：基于某版本复制出新一代版本，常用于"在上版基础上改"
- **版本对比**：任选两个版本，列出新增 / 删除 / 修改的文件清单
- **源码浏览**：在线树形浏览任意版本的源码，支持文本文件预览（带行号）、文件过滤
- **思路流程文档**：每个项目独立维护一份 Markdown 思路流程文档，记录目标、思路、关键步骤、踩坑、可优化点
- **版本下载**：将任意版本源码打包为 zip 下载

## 目录结构

```
crawler_manager/
├── app.py                      # Flask 入口
├── config.py                   # 配置
├── requirements.txt
├── core/                       # 核心业务
│   ├── models.py               # 数据模型
│   ├── storage.py              # 文件/JSON 存储
│   ├── project_manager.py      # 项目与版本管理
│   └── version_manager.py      # 源码树/文件读取
├── api/
│   └── projects.py             # REST API
├── templates/                  # Jinja2 页面
├── static/                     # CSS/JS
└── data/projects/              # 项目数据（运行时生成）
    └── {project_name}/
        ├── metadata.json
        ├── flow_notes.md
        └── versions/{version}/source/...
```

## 安装与运行

```bash
cd crawler_manager
pip install -r requirements.txt
python app.py
```

默认监听 `http://127.0.0.1:5000`。

## 使用流程

1. 打开首页 → 点击"新增爬虫项目"
2. 填写名称、描述、标签，选择初始版本号，选择整个爬虫项目文件夹上传
3. 在项目详情页点击"思路流程"维护思路文档
4. 当目标站点更新需要重写爬虫时：
   - 先看"思路流程"回顾上版思路
   - 点击"+ 新增版本"，上传新版完整文件夹
   - 可在版本列表中"切换"当前版本、"浏览源码"在线查看、"下载"打包带走

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | /api/projects | 项目列表 |
| POST | /api/projects | 新建项目（multipart：name/description/tags/initial_version/files） |
| GET  | /api/projects/\<name\> | 项目详情 |
| PUT  | /api/projects/\<name\> | 编辑项目（可改名称/描述/标签） |
| DELETE | /api/projects/\<name\> | 删除项目 |
| GET  | /api/projects/\<name\>/versions | 版本列表 |
| POST | /api/projects/\<name\>/versions | 新增版本（multipart：version/description/files） |
| PUT  | /api/projects/\<name\>/versions/\<v\> | 修改版本说明 |
| DELETE | /api/projects/\<name\>/versions/\<v\> | 删除版本 |
| POST | /api/projects/\<name\>/versions/\<v\>/switch | 切换当前版本 |
| POST | /api/projects/\<name\>/versions/\<v\>/replace | 替换版本源码（multipart：files） |
| POST | /api/projects/\<name\>/versions/copy | 从已有版本复制创建新版本（json：src_version/new_version/description/set_as_current） |
| GET  | /api/projects/\<name\>/versions/\<a\>/diff/\<b\> | 两版本文件差异对比 |
| GET  | /api/projects/\<name\>/versions/\<v\>/tree | 源码文件树 |
| GET  | /api/projects/\<name\>/versions/\<v\>/file?path= | 读取文件内容 |
| GET  | /api/projects/\<name\>/versions/\<v\>/download | 下载版本 zip |
| GET  | /api/projects/\<name\>/flow | 获取思路流程 |
| PUT  | /api/projects/\<name\>/flow | 更新思路流程 |

## 上传过滤

自动忽略 `__pycache__`、`.git`、`.venv`、`node_modules`、`.idea`、`.vscode`、`*.egg-info`、`.pyc`、`.DS_Store` 等目录与文件。

## 后续可扩展

- 项目搜索/按标签筛选
- 思路流程 Markdown 渲染预览
- 版本间逐文件内容级 diff（行级）
- 项目依赖环境一键导出/复现
- 多用户/权限
- 导出整个管理库为单 zip 备份