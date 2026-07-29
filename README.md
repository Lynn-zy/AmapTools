# 高德地图POI爬虫

## 功能说明
爬取指定城市、指定场景的POI数据，保存为GeoJSON和Excel格式

## 安装依赖
```bash
pip install -r requirements.txt
```

## 使用方法
1. 在 [高德开放平台](https://console.amap.com/dev/key/app) 申请免费的API Key
2. 修改 `poi_crawler.py` 文件第14行，将 `YOUR_AMAP_API_KEY` 替换为你的API Key
3. 根据需要修改配置参数（第17-23行）：
   - `CITY`: 城市名称
   - `SCENE_KEYWORD`: 搜索关键词（多个用|分隔）
   - `SCENE_NAME`: 场景名称
4. 运行程序：
```bash
python poi_crawler.py
```

## 输出文件
- `E:/{城市名}_{场景名}_POI.geojson` - GeoJSON格式
- `E:/{城市名}_{场景名}_POI.xlsx` - Excel格式

## 注意事项
- 免费版API限制：QPS=100，每日配额根据账号等级而定
- 建议在请求间添加延时，避免触发限流
