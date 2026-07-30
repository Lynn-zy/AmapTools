#!/usr/bin/env python
# -*- coding: utf-8 -*-
import requests, json, time, pandas as pd, os, sys
from datetime import datetime

AMAP_KEY = "a317256e7b4bec1545a396c92e9a03bc"
TARGET_CITY = "郑州市"
TARGET_TYPE = "180300"
SCENE_KEYWORD = ""
SCENE_NAME = "高速服务区"
OUTPUT_DIR = "E:/"
REQUEST_INTERVAL = 0.2

DISTRICT_URL = "https://restapi.amap.com/v3/config/district"
POLYGON_URL = "https://restapi.amap.com/v3/place/polygon"
TEXT_URL = "https://restapi.amap.com/v3/place/text"

TYPE_NAMES = {
    "180300": "高速服务区", "150000": "交通设施",
    "050000": "餐饮", "060000": "酒店", "100000": "购物",
    "010000": "汽车服务", "020000": "汽车销售", "030000": "汽车维修",
    "010100": "加油站", "150600": "停车场", "150500": "收费站",
}

def get_type_name(code):
    return TYPE_NAMES.get(code, code)

class AmapPOICrawler:
    def __init__(self, api_key):
        self.api_key = api_key
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "Mozilla/5.0"})

    def get_city_boundary(self, city_name):
        params = {"key": self.api_key, "keywords": city_name, "subdistrict": 1, "extensions": "all"}
        try:
            r = self.session.get(DISTRICT_URL, params=params, timeout=10)
            data = r.json()
            if data.get("status") != "1" or not data.get("districts"):
                print("[ERROR] 获取城市信息失败:", data.get("info", "未知"))
                return None
            dist = data["districts"][0]
            polyline = dist.get("polyline", "")
            coords = []
            if polyline:
                for pt in polyline.split(";"):
                    if "," in pt:
                        l, g = pt.split(",")
                        coords.append((float(l), float(g)))
            subs = []
            for s in dist.get("districts", []):
                sp = s.get("polyline", "")
                if sp:
                    sc = []
                    for pt in sp.split(";"):
                        if "," in pt:
                            l, g = pt.split(",")
                            sc.append((float(l), float(g)))
                    subs.append({"name": s.get("name",""), "adcode": s.get("adcode",""), "polygon": sc})
            bbox = None
            if coords:
                lngs = [p[0] for p in coords]
                lats = [p[1] for p in coords]
                bbox = (min(lngs), min(lats), max(lngs), max(lats))
            print("[INFO] 城市:", dist.get("name"), "| 边界点数:", len(coords), "| 区县:", len(subs))
            return {"name": dist.get("name", city_name), "adcode": dist.get("adcode",""),
                    "polygon": coords, "bbox": bbox, "subs": subs}
        except Exception as e:
            print("[ERROR] 请求异常:", e)
            return None

    def search_by_boundary(self, keywords, polygon_str, max_pages=50):
        all_pois, seen = [], set()
        for pg in range(1, max_pages+1):
            for retry in range(3):
                try:
                    params = {"key": self.api_key, "types": keywords, "polygon": polygon_str,
                              "offset": 25, "page": pg, "extensions": "all"}
                    r = self.session.get(POLYGON_URL, params=params, timeout=10)
                    data = r.json()
                    if data.get("status") != "1":
                        info = data.get("info", "")
                        if "EXCEED" in info.upper(): time.sleep(2); continue
                        if pg == 1: print("[WARN] API错误:", info)
                        return all_pois
                    pois = data.get("pois", [])
                    if not pois: return all_pois
                    new_n = 0
                    for poi in pois:
                        k = poi.get("name","") + "_" + poi.get("location","")
                        if k not in seen: seen.add(k); all_pois.append(poi); new_n += 1
                    if pg == 1: print("[INFO] 总量:", data.get("count","?"), "条")
                    if new_n == 0 or len(pois) < 25: return all_pois
                    break
                except Exception as e:
                    print("[WARN] 第%d页异常:" % pg, e); return all_pois
            time.sleep(REQUEST_INTERVAL)
        return all_pois

    def search_by_grid(self, keywords, bbox, gc=3, gr=3):
        min_lng, min_lat, max_lng, max_lat = bbox
        cw, ch = (max_lng-min_lng)/gc, (max_lat-min_lat)/gr
        all_pois, seen = [], set()
        for r in range(gr):
            for c in range(gc):
                x1, y1 = min_lng+c*cw, min_lat+r*ch
                x2, y2 = x1+cw, y1+ch
                poly = "%.6f,%.6f|%.6f,%.6f|%.6f,%.6f|%.6f,%.6f|%.6f,%.6f" % (x1,y1,x2,y1,x2,y2,x1,y2,x1,y1)
                cell_id, total = r*gc+c+1, gc*gr
                for pg in range(1, 5):
                    for retry in range(3):
                        try:
                            params = {"key": self.api_key, "types": keywords, "polygon": poly,
                                      "offset": 25, "page": pg, "extensions": "all"}
                            r2 = self.session.get(POLYGON_URL, params=params, timeout=10)
                            data = r2.json()
                            if data.get("status") != "1":
                                if "EXCEED" in data.get("info","").upper(): time.sleep(2); continue
                                break
                            pois = data.get("pois", [])
                            if not pois: break
                            new_n = 0
                            for poi in pois:
                                k = poi.get("name","") + "_" + poi.get("location","")
                                if k not in seen: seen.add(k); all_pois.append(poi); new_n += 1
                            if pg == 1 and new_n > 0:
                                print("[INFO]   [%d/%d] +%d (累计%d)" % (cell_id, total, new_n, len(all_pois)))
                            if new_n == 0 or len(pois) < 25: break
                            break
                        except: break
                    time.sleep(REQUEST_INTERVAL)
        return all_pois

    def search_by_text(self, keywords, city, max_pages=50):
        all_pois, seen = [], set()
        for pg in range(1, max_pages+1):
            try:
                params = {"key": self.api_key, "types": keywords, "city": city,
                          "citylimit": "true", "offset": 25, "page": pg, "extensions": "all"}
                r = self.session.get(TEXT_URL, params=params, timeout=10)
                data = r.json()
                if data.get("status") != "1":
                    if pg == 1: print("[WARN] API错误:", data.get("info",""))
                    break
                pois = data.get("pois", [])
                if not pois: break
                new_n = 0
                for poi in pois:
                    k = poi.get("name","") + "_" + poi.get("location","")
                    if k not in seen: seen.add(k); all_pois.append(poi); new_n += 1
                if pg == 1: print("[INFO] 总量:", data.get("count","?"), "条")
                if len(pois) < 25: break
            except Exception as e:
                print("[WARN] 第%d页异常:" % pg, e); break
            time.sleep(REQUEST_INTERVAL)
        return all_pois

    def crawl(self, city, scene_type="", scene_keyword="", use_grid=False):
        keywords = scene_keyword if scene_keyword else scene_type
        print("[Step 1] 获取城市边界...")
        ci = self.get_city_boundary(city)
        if not ci:
            print("[WARN] 无边界, 切换文本搜索")
            return self.search_by_text(keywords, city)
        self._save_boundary_geojson(ci)
        print("[Step 2] 搜索POI...")
        print("[INFO] 类型代码:", keywords, "| 模式:", "网格" if use_grid else "多边形")
        if use_grid and ci.get("bbox"):
            pois = self.search_by_grid(keywords, ci["bbox"])
        elif ci.get("polygon"):
            coords = ci["polygon"]
            if len(coords) > 40:
                step = max(1, len(coords)//40)
                coords = coords[::step]
                if coords[0] != coords[-1]: coords.append(coords[-1])
            ps = "|".join("%.6f,%.6f" % (p[0],p[1]) for p in coords)
            pois = self.search_by_boundary(keywords, ps)
        else:
            pois = self.search_by_text(keywords, city)
        if not pois:
            print("[WARN] 边界搜索无结果, 尝试文本搜索...")
            pois = self.search_by_text(keywords, city)
        return pois

    def _save_boundary_geojson(self, ci):
        if not ci.get("polygon"): return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = OUTPUT_DIR + ci["name"] + "_边界_" + ts + ".geojson"
        feats = [{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in ci["polygon"]]]},
                   "properties": {"name": ci["name"], "level": "city",
                                  "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}}]
        for s in ci.get("subs", []):
            if s.get("polygon"):
                feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in s["polygon"]]]},
                              "properties": {"name": s["name"], "adcode": s["adcode"], "level": "district",
                                             "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}})
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, ensure_ascii=False)
        print("[INFO] 边界:", path, "(%.1f KB)" % (os.path.getsize(path)/1024))

    def export_geojson(self, pois, city, scene):
        if not pois: return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = OUTPUT_DIR + city + "_" + scene + "_" + ts + ".geojson"
        feats = []
        for poi in pois:
            loc = poi.get("location","")
            if not loc or "," not in loc: continue
            l, g = loc.split(",")
            feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(l),float(g)]},
                          "properties": {"name": poi.get("name",""), "type": poi.get("type",""),
                                         "typecode": poi.get("typecode",""), "address": poi.get("address",""),
                                         "tel": poi.get("tel",""), "pname": poi.get("pname",""),
                                         "cityname": poi.get("cityname",""), "adname": poi.get("adname",""),
                                         "adcode": poi.get("adcode",""), "source": "AMap",
                                         "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}})
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": feats,
                       "metadata": {"source": "高德地图", "city": city, "scene": scene,
                                    "total": len(feats), "crawl_time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}},
                      f, ensure_ascii=False)
        print("[INFO] GeoJSON:", path, "(%.1f KB)" % (os.path.getsize(path)/1024))

    def export_excel(self, pois, city, scene):
        if not pois: return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        path = OUTPUT_DIR + city + "_" + scene + "_" + ts + ".xlsx"
        data = []
        for poi in pois:
            loc = poi.get("location","")
            l, g = (loc.split(",") if loc and "," in loc else ("",""))
            data.append({"名称": poi.get("name",""), "地址": poi.get("address",""),
                         "经度": l, "纬度": g, "类型": poi.get("type",""),
                         "类型代码": poi.get("typecode",""), "电话": poi.get("tel",""),
                         "省份": poi.get("pname",""), "城市": poi.get("cityname",""),
                         "区域": poi.get("adname",""), "POI ID": poi.get("id","")})
        pd.DataFrame(data).to_excel(path, index=False, sheet_name=(city+scene)[:31])
        print("[INFO] Excel:", path, "(%.1f KB)" % (os.path.getsize(path)/1024))

def main():
    print("=" * 50)
    print("高德地图POI爬取工具")
    print("目标城市:", TARGET_CITY)
    print("目标类型:", TARGET_TYPE, "(" + get_type_name(TARGET_TYPE) + ")")
    if SCENE_KEYWORD: print("关键词:", SCENE_KEYWORD)
    print("用法: python polygon_crawler.py          # 多边形搜索")
    print("       python polygon_crawler.py --grid  # 网格搜索(推荐)")
    print("=" * 50)
    if AMAP_KEY == "你的高德API Key":
        print("[ERROR] 请先配置高德API Key!"); return
    crawler = AmapPOICrawler(AMAP_KEY)
    use_grid = "--grid" in sys.argv
    sys.stdout.flush()
    pois = crawler.crawl(TARGET_CITY, TARGET_TYPE, SCENE_KEYWORD, use_grid)
    print("[Step 3] 导出数据 (%d条)..." % len(pois))
    sys.stdout.flush()
    sn = SCENE_NAME or get_type_name(TARGET_TYPE)
    if pois:
        crawler.export_geojson(pois, TARGET_CITY, sn)
        crawler.export_excel(pois, TARGET_CITY, sn)
    types = {}
    for poi in pois:
        t = poi.get("type","未知").split(";")[0]
        types[t] = types.get(t, 0) + 1
    if types:
        print("类型统计:")
        for t, c in sorted(types.items(), key=lambda x: -x[1])[:10]:
            print(" ", t, ":", c, "条")
    print("[完成] 共 %d 条POI" % len(pois))

if __name__ == "__main__":
    main()
