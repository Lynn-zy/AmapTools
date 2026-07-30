#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
高德地图POI爬虫
爬取指定城市、指定场景的POI数据，保存为GeoJSON和Excel格式
"""

import requests
import json
import pandas as pd
from datetime import datetime
import time
import urllib.parse

# 配置参数
# 请替换为你的高德地图API Key（免费申请：https://console.amap.com/dev/key/app）
AMAP_API_KEY = "YOUR_AMAP_API_KEY"

# 城市和场景配置
CITY = "济南市"  # 城市名称
SCENE_KEYWORD = "景点|景区|公园|旅游|风景区|景点景区"  # 搜索关键词，多个关键词用|分隔
SCENE_NAME = "景点旅游"  # 场景名称（用于文件命名）

# 输出路径
OUTPUT_DIR = "E:/"

# 高德地图POI API配置
AMAP_POI_URL = "https://restapi.amap.com/v3/place/text"


def get_poi_data(keywords, city, page=1):
    """
    调用高德地图POI API获取数据

    Args:
        keywords: 搜索关键词
        city: 城市名称
        page: 页码

    Returns:
        dict: API返回的数据
    """
    params = {
        "key": AMAP_API_KEY,
        "keywords": keywords,
        "city": city,
        "citylimit": "true",  # 限制在城市范围内
        "offset": 20,  # 每页20条
        "page": page,
        "extensions": "all",  # 返回详细信息
        "output": "json"
    }

    try:
        response = requests.get(AMAP_POI_URL, params=params, timeout=10)
        response.raise_for_status()
        return response.json()
    except Exception as e:
        print(f"请求失败: {e}")
        return None


def parse_poi_to_geojson(poi_list):
    """
    将POI列表转换为GeoJSON格式

    Args:
        poi_list: POI数据列表

    Returns:
        dict: GeoJSON格式的数据
    """
    features = []

    for poi in poi_list:
        # 解析经纬度
        location = poi.get("location", "")
        if location:
            lng, lat = location.split(",")
        else:
            continue

        # 构建GeoJSON Feature
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
                "postcode": poi.get("postcode", ""),
                "website": poi.get("website", ""),
                "email": poi.get("email", ""),
                "province": poi.get("province", ""),
                "city": poi.get("city", ""),
                "adcode": poi.get("adcode", ""),
                "adname": poi.get("adname", ""),
                "business_area": poi.get("business_area", ""),
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
            "crawl_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
    }

    return geojson


def parse_poi_to_dataframe(poi_list):
    """
    将POI列表转换为DataFrame

    Args:
        poi_list: POI数据列表

    Returns:
        DataFrame: POI数据
    """
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
            "邮编": poi.get("postcode", ""),
            "网站": poi.get("website", ""),
            "邮箱": poi.get("email", ""),
            "省份": poi.get("province", ""),
            "城市": poi.get("city", ""),
            "区划代码": poi.get("adcode", ""),
            "区域名称": poi.get("adname", ""),
            "商圈": poi.get("business_area", ""),
            "经度": lng,
            "纬度": lat,
            "爬取时间": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })

    return pd.DataFrame(data)


def main():
    """
    主函数
    """
    print(f"开始爬取 {CITY} 的 {SCENE_NAME} 数据...")
    print(f"API Key: {AMAP_API_KEY if AMAP_API_KEY != 'YOUR_AMAP_API_KEY' else '未配置'}")

    # 检查API Key
    if AMAP_API_KEY == "YOUR_AMAP_API_KEY":
        print("\n错误: 请先在代码中配置你的高德地图API Key！")
        print("申请地址: https://console.amap.com/dev/key/app")
        return

    # 分割关键词，支持多个场景
    keywords_list = SCENE_KEYWORD.split("|")

    all_poi_list = []
    total_count = 0

    for keywords in keywords_list:
        print(f"\n正在搜索关键词: {keywords}")
        page = 1
        max_pages = 50  # 最大页数限制

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
            count = len(pois)

            if count == 0:
                print("无更多数据")
                break

            all_poi_list.extend(pois)
            total_count += count
            print(f"获取 {count} 条，累计 {total_count} 条")

            # 检查是否还有下一页
            if count < 20:
                break

            page += 1

            # 避免请求过快（高德API限制：QPS=100）
            time.sleep(0.1)

    if not all_poi_list:
        print("\n未获取到任何数据！")
        return

    print(f"\n共获取 {len(all_poi_list)} 条POI数据")

    # 保存为GeoJSON
    geojson_data = parse_poi_to_geojson(all_poi_list)
    geojson_filename = f"{OUTPUT_DIR}{CITY}_{SCENE_NAME}_POI.geojson"
    with open(geojson_filename, "w", encoding="utf-8") as f:
        json.dump(geojson_data, f, ensure_ascii=False, indent=2)
    print(f"已保存GeoJSON: {geojson_filename}")

    # 保存为Excel
    df = parse_poi_to_dataframe(all_poi_list)
    excel_filename = f"{OUTPUT_DIR}{CITY}_{SCENE_NAME}_POI.xlsx"
    df.to_excel(excel_filename, index=False, sheet_name="POI数据")
    print(f"已保存Excel: {excel_filename}")

    # 显示前几条数据预览
    print("\n数据预览:")
    print(df.head(10).to_string())

    print(f"\n爬取完成！共保存 {len(all_poi_list)} 条数据")


if __name__ == "__main__":
    main()
