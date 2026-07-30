#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
高德地图POI爬虫 - 郑州市高速服务区
爬取郑州市高速服务区数据，保存为GeoJSON和Excel格式
"""

import requests
import json
import pandas as pd
from datetime import datetime
import time
import os

# ===== 配置参数 =====
AMAP_API_KEY = "a317256e7b4bec1545a396c92e9a03bc"

CITY = "郑州市"
# 高速服务区相关搜索关键词
SCENE_KEYWORD = "高速服务区|高速公路服务区|服务区"
SCENE_NAME = "高速服务区"

OUTPUT_DIR = "E:/"

AMAP_POI_URL = "https://restapi.amap.com/v3/place/text"
AMAP_POLYGON_URL = "https://restapi.amap.com/v3/place/polygon"


def get_poi_data(keywords, city, page=1):
    """调用高德地图POI文本搜索API获取数据"""
    params = {
        "key": AMAP_API_KEY,
        "keywords": keywords,
        "city": city,
        "citylimit": "true",
        "offset": 25,
        "page": page,
        "extensions": "all",
        "output": "json"
    }
    try:
        response = requests.get(AMAP_POI_URL, params=params, timeout=10)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"  请求失败: {e}")
        return None


def get_poi_by_polygon(keywords, polygon, page=1):
    """调用高德地图POI多边形搜索API获取数据（可获取边界信息）"""
    params = {
        "key": AMAP_API_KEY,
        "keywords": keywords,
        "polygon": polygon,
        "offset": 25,
        "page": page,
        "extensions": "all",
        "output": "json"
    }
    try:
        response = requests.get(AMAP_POLYGON_URL, params=params, timeout=10)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"  多边形搜索请求失败: {e}")
        return None


def parse_poi_to_geojson(poi_list):
    """将POI列表转换为GeoJSON格式"""
    features = []

    for poi in poi_list:
        location = poi.get("location", "")
        if location:
            lng, lat = location.split(",")
        else:
            continue

        # 尝试获取边界信息（高德扩展字段）
        business_area = poi.get("business_area", "")
        deep_info = poi.get("deep_info", "")
        shape_info = ""
        if isinstance(deep_info, dict):
            shape_info = deep_info.get("shape", "")

        feature = {
            "type": "Feature",
            "geometry": {
                "type": "Point",
                "coordinates": [float(lng), float(lat)]
            },
            "properties": {
                "name": poi.get("name", ""),
                "type": poi.get("type", ""),
                "address": poi.get("address", ""),
                "tel": poi.get("tel", ""),
                "province": poi.get("province", ""),
                "city": poi.get("city", ""),
                "adcode": poi.get("adcode", ""),
                "adname": poi.get("adname", ""),
                "pname": poi.get("pname", ""),
                "cityname": poi.get("cityname", ""),
                "adname_detail": poi.get("adname", ""),
                "business_area": business_area,
                "distance": poi.get("distance", ""),
                "website": poi.get("website", ""),
                "email": poi.get("email", ""),
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            }
        }
        features.append(feature)

    geojson = {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "source": "高德地图POI",
            "city": CITY,
            "scene": SCENE_NAME,
            "crawl_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "total_count": len(poi_list)
        }
    }

    return geojson


def parse_poi_to_dataframe(poi_list):
    """将POI列表转换为DataFrame"""
    data = []

    for poi in poi_list:
        location = poi.get("location", "")
        if location:
            lng, lat = location.split(",")
        else:
            lng, lat = "", ""

        data.append({
            "名称": poi.get("name", ""),
            "类型": poi.get("type", ""),
            "地址": poi.get("address", ""),
            "电话": poi.get("tel", ""),
            "省份": poi.get("province", ""),
            "城市": poi.get("city", ""),
            "区域": poi.get("adname", ""),
            "区划代码": poi.get("adcode", ""),
            "商圈": poi.get("business_area", ""),
            "经度": lng,
            "纬度": lat,
            "网站": poi.get("website", ""),
            "邮箱": poi.get("email", ""),
            "爬取时间": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })

    return pd.DataFrame(data)


def main():
    """主函数"""
    print("=" * 60)
    print(f"高德地图POI爬虫 - {CITY} {SCENE_NAME}")
    print("=" * 60)
    print(f"API Key: {AMAP_API_KEY[:8]}...{AMAP_API_KEY[-4:]}")

    # 检查API Key
    if AMAP_API_KEY == "YOUR_AMAP_API_KEY":
        print("\n错误: 请先配置你的高德地图API Key！")
        return

    # 分割关键词
    keywords_list = SCENE_KEYWORD.split("|")

    all_poi_list = []
    total_count = 0
    all_names = set()  # 去重

    for keywords in keywords_list:
        print(f"\n正在搜索关键词: {keywords}")
        page = 1
        max_pages = 50

        while page <= max_pages:
            print(f"  第 {page} 页...", end=" ")

            data = get_poi_data(keywords, CITY, page)

            if not data:
                print("请求失败，跳过")
                break

            if data.get("status") != "1":
                print(f"API错误: {data.get('info', '未知错误')}")
                break

            pois = data.get("pois", [])
            count = 0

            for poi in pois:
                name = poi.get("name", "")
                location = poi.get("location", "")
                # 简单去重：同名称+同位置视为重复
                dedup_key = f"{name}_{location}"
                if dedup_key not in all_names:
                    all_names.add(dedup_key)
                    all_poi_list.append(poi)
                    count += 1

            total_count += count
            print(f"新增 {count} 条，累计 {total_count} 条")

            if count < 25:
                print("  已到最后一页")
                break

            page += 1
            time.sleep(0.15)  # 控制请求频率

    if not all_poi_list:
        print(f"\n未获取到任何数据！请检查关键词或API Key是否有效。")
        return

    print(f"\n{'=' * 60}")
    print(f"共获取 {len(all_poi_list)} 条{SCENE_NAME}数据")

    # 保存为GeoJSON
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    geojson_data = parse_poi_to_geojson(all_poi_list)
    geojson_filename = f"{OUTPUT_DIR}{CITY}_{SCENE_NAME}_{timestamp}.geojson"
    with open(geojson_filename, "w", encoding="utf-8") as f:
        json.dump(geojson_data, f, ensure_ascii=False, indent=2)
    print(f"已保存 GeoJSON: {geojson_filename}")
    file_size = os.path.getsize(geojson_filename)
    print(f"  文件大小: {file_size / 1024:.1f} KB")

    # 保存为Excel
    df = parse_poi_to_dataframe(all_poi_list)
    excel_filename = f"{OUTPUT_DIR}{CITY}_{SCENE_NAME}_{timestamp}.xlsx"
    df.to_excel(excel_filename, index=False, sheet_name=f"{CITY}{SCENE_NAME}")
    print(f"已保存 Excel: {excel_filename}")
    file_size = os.path.getsize(excel_filename)
    print(f"  文件大小: {file_size / 1024:.1f} KB")

    # 数据预览
    print(f"\n数据预览（前10条）:")
    print("-" * 80)
    preview_cols = ["名称", "类型", "地址", "经度", "纬度"]
    print(df[preview_cols].head(10).to_string(index=False))

    print(f"\n{'=' * 60}")
    print(f"爬取完成！共保存 {len(all_poi_list)} 条数据到 E:/ 根目录")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
