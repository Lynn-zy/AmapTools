# AmapTools - 高德地图扩展工具

## 简介

- AmapTools 是一款 Tampermonkey 用户脚本，用于拦截高德地图 **驾车、公交、步行** 的路线规划结果，并转换为 **GeoJSON / KML / GPX**，便于在 GIS、户外设备或其它工具中使用。
- 支持当前常见的高德地图网页界面，在规划路线后即可使用本工具导出数据。
- 喜欢这个插件的话，欢迎在 GitHub 上点个 ⭐ Star 支持一下。

## 功能

- **路线数据获取**：将规划结果转换为 GeoJSON（坐标系为 GCJ-02），并可导出为 **KML、GPX**。
- **导出方式**：在面板中选择 **GeoJSON / KML / GPX**（单选），再使用 **复制** 或 **下载**；不会在切换路线时自动写入剪贴板。
- **与页面对齐**：在工具面板中切换 **出行方式** 或 **路线方案** 时，尽量与页面上的选项保持一致（若页面结构变化导致偶发不同步，可刷新或反馈）。
- **第三方账号登录**：辅助使用密码或第三方等方式登录高德地图；**已随新版网页界面完成适配**。
- **可拖拽面板**：支持拖动工具面板位置并记忆大致位置。

## 安装

### 1. 安装 Tampermonkey

请安装 [Tampermonkey](https://www.tampermonkey.net/) 等用户脚本管理器。

### 2. 安装 AmapTools

- GreasyFork：[AmapTools - GreasyFork](https://greasyfork.org/zh-CN/scripts/507634-amaptools)
- GitHub：[AmapTools - GitHub](https://github.com/10D24D/AmapTools)

### 3. 支持的网站

脚本会在以下域名下运行：

- `https://www.amap.com/*`
- `https://ditu.amap.com/*`
- `https://www.gaode.com/*`

## 贡献

欢迎通过 Issue / Pull Request 反馈问题或提交改进：[GitHub 仓库](https://github.com/10D24D/AmapTools)。

## 许可协议

MIT License。你可以自由使用、修改和分发本项目的代码。

## 免责声明

本脚本仅供学习、研究和个人非商业用途，请勿用于可能违反高德地图服务条款的场景。

使用本脚本可能涉及高德地图的 API 规则与数据版权，请遵守相关法律法规及服务协议。因使用本脚本产生的纠纷或责任由使用者自行承担，开发者不承担责任。

「高德地图」为相应权利人的商标；本脚本与高德官方无关联。
