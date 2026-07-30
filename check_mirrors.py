import requests

# Check China OSM data mirrors
mirrors = [
    "https://mirrors.ustc.edu.cn/osm/",
]

for url in mirrors:
    try:
        r = requests.get(url, timeout=15)
        print(f"{url}: {r.status_code}")
        print(r.text[:500])
    except Exception as e:
        print(f"{url}: {e}")
    print("---")

# Try to find Zhengzhou-level or Henan-level OSM extract
# Check USTC mirror for Geofabrik China
try:
    r = requests.get("https://mirrors.ustc.edu.cn/osm/download.geofabrik.de/asia/china-latest.osm.pbf.md5", timeout=15)
    print(f"China PBF MD5: {r.status_code}")
    if r.status_code == 200:
        print(r.text[:100])
except Exception as e:
    print(f"China PBF MD5 Error: {e}")

# Check if there's a China-wide or Henan-specific extract at a smaller size
try:
    r = requests.get("https://mirrors.ustc.edu.cn/osm/download.geofabrik.de/asia/", timeout=15)
    print(f"Geofabrik Asia listing: {r.status_code}")
    print(r.text[:1000])
except Exception as e:
    print(f"Geofabrik listing error: {e}")
