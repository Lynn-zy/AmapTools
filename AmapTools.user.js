// ==UserScript==
// @name         AmapTools
// @description  高德地图扩展工具。支持在搜索地点（小区、学校、园区等）定位或点击地图标注时，自动提取 AOI 区域边界并导出为 GeoJSON 格式，支持 GCJ-02 / WGS-84 坐标系切换。
// @version      2.1.0
// @author       Lynn-zy
// @namespace    https://github.com/Lynn-zy/AmapTools/
// @supportURL   https://github.com/Lynn-zy/AmapTools/
// @match        https://www.amap.com/*
// @match        https://ditu.amap.com/*
// @match        https://www.gaode.com/*
// @icon         https://a.amap.com/pc/static/favicon.ico
// @license      MIT
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  /** 当前拦截并解析出的 AOI 区域多边形数据 */
  let currentPolygonData = null;
  /** 面板位置记忆（支持拖拽定位记忆） */
  let polygonPanelPosition = { left: null, top: null };
  /** 面板拖拽状态标记 */
  let isDragging = false;
  /** 拖拽相对横坐标偏移量 */
  let dragOffsetX = 0;
  /** 拖拽相对纵坐标偏移量 */
  let dragOffsetY = 0;

  // ========== 接口匹配 ==========

  /**
   * 判断目标 URL 是否为需要拦截的 AOI 区域数据接口
   * 覆盖场景：
   * 1. 搜索框检索定位接口：/service/poiInfo、/service/new_key_search
   * 2. 地图地名标签点击/详情接口：/detail/get/detail、/ssr/api/getPoiDetail、/ssr/api/getPoiInfo
   * @param {string} url - 请求的目标 URL
   * @returns {boolean} 是否为目标接口
   */
  const isTargetAoiUrl = (url) => {
    const u = String(url || "");
    return (
      u.includes("/service/poiInfo") ||
      u.includes("/service/new_key_search") ||
      u.includes("/detail/get/detail") ||
      u.includes("/ssr/api/getPoiDetail") ||
      u.includes("/ssr/api/getPoiInfo")
    );
  };

  // ========== GCJ-02 → WGS-84 坐标转换 ==========

  /** GCJ-02 坐标转换常量：长半轴 */
  const GCJ_A = 6378245.0;
  /** GCJ-02 坐标转换常量：扁率偏心率平方 */
  const GCJ_EE = 0.00669342162296594;

  /**
   * 判断坐标是否在中国境外（境外坐标无需偏移纠偏）
   * @param {number} lng - 经度
   * @param {number} lat - 纬度
   * @returns {boolean} 是否境外
   */
  const isOutOfChina = (lng, lat) => {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  };

  /**
   * 纬度偏移量计算算法
   * @param {number} x - 相对经度
   * @param {number} y - 相对纬度
   * @returns {number} 纬度偏移量
   */
  const transformLat = (x, y) => {
    let ret =
      -100.0 +
      2.0 * x +
      3.0 * y +
      0.2 * y * y +
      0.1 * x * y +
      0.2 * Math.sqrt(Math.abs(x));
    ret +=
      ((20.0 * Math.sin(6.0 * x * Math.PI) +
        20.0 * Math.sin(2.0 * x * Math.PI)) *
        2.0) /
      3.0;
    ret +=
      ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) *
        2.0) /
      3.0;
    ret +=
      ((160.0 * Math.sin((y / 12.0) * Math.PI) +
        320 * Math.sin((y * Math.PI) / 30.0)) *
        2.0) /
      3.0;
    return ret;
  };

  /**
   * 经度偏移量计算算法
   * @param {number} x - 相对经度
   * @param {number} y - 相对纬度
   * @returns {number} 经度偏移量
   */
  const transformLng = (x, y) => {
    let ret =
      300.0 +
      x +
      2.0 * y +
      0.1 * x * x +
      0.1 * x * y +
      0.1 * Math.sqrt(Math.abs(x));
    ret +=
      ((20.0 * Math.sin(6.0 * x * Math.PI) +
        20.0 * Math.sin(2.0 * x * Math.PI)) *
        2.0) /
      3.0;
    ret +=
      ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) *
        2.0) /
      3.0;
    ret +=
      ((150.0 * Math.sin((x / 12.0) * Math.PI) +
        300.0 * Math.sin((x / 30.0) * Math.PI)) *
        2.0) /
      3.0;
    return ret;
  };

  /**
   * 将单个火星坐标系（GCJ-02）坐标转换为地球坐标系（WGS-84）
   * @param {number} lng - GCJ-02 经度
   * @param {number} lat - GCJ-02 纬度
   * @returns {[number, number]} 转换后的 WGS-84 [经度, 纬度]
   */
  const gcj02ToWgs84 = (lng, lat) => {
    if (isOutOfChina(lng, lat)) return [lng, lat];
    let dlat = transformLat(lng - 105.0, lat - 35.0);
    let dlng = transformLng(lng - 105.0, lat - 35.0);
    const radlat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radlat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtmagic = Math.sqrt(magic);
    dlat =
      (dlat * 180.0) /
      (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtmagic)) * Math.PI);
    dlng = (dlng * 180.0) / ((GCJ_A / sqrtmagic) * Math.cos(radlat) * Math.PI);
    return [lng - dlng, lat - dlat];
  };

  /**
   * 批量转换坐标数组从 GCJ-02 到 WGS-84
   * @param {Array<[number, number]>} coordinates - 坐标数组
   * @returns {Array<[number, number]>} 转换后的坐标数组
   */
  const convertCoordinatesArray = (coordinates) => {
    return coordinates.map((coord) => gcj02ToWgs84(coord[0], coord[1]));
  };

  // ========== AOI 区域边界解析 ==========

  /**
   * 解析经纬度字符串为闭合多边形坐标数组
   * 兼容高德地图返回的两种分隔符格式：
   * 1. 分号分隔（详情接口）："lng,lat;lng,lat;..."
   * 2. 下划线分隔（搜索接口）："lng,lat_lng,lat_..."
   * @param {string} shapeStr - 原始坐标字符串
   * @returns {Array<[number, number]>|null} 多边形坐标数组或解析失败返回 null
   */
  const parseCoordinateString = (shapeStr) => {
    if (!shapeStr || typeof shapeStr !== "string") return null;

    const coordinates = [];
    // 同时兼容 ';' 和 '_' 两种分隔符
    shapeStr.split(/[;_]/).forEach((seg) => {
      const parts = seg.split(",").map(Number);
      if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
        coordinates.push([parts[0], parts[1]]);
      }
    });

    // 多边形必须至少有 3 个顶点
    if (coordinates.length < 3) return null;

    // 确保 GeoJSON 多边形首尾点闭合
    const first = coordinates[0];
    const last = coordinates[coordinates.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      coordinates.push([first[0], first[1]]);
    }

    return coordinates;
  };

  /**
   * 从详情类接口响应中提取 AOI 区域数据
   * 路径：data.spec.mining_shape.shape
   * @param {Object} data - 接口响应的 data 数据体
   * @returns {Object|null} 标准化 AOI 数据结构
   */
  const parseDetailData = (data) => {
    if (!data) return null;

    const shapeStr = data.spec?.mining_shape?.shape;
    const coordinates = parseCoordinateString(shapeStr);
    if (!coordinates) return null;

    const base = data.base || {};
    const miningShape = data.spec?.mining_shape || {};

    return {
      name: base.name || "",
      address: base.address || "",
      tag: base.tag || base.classify || "",
      poiid: base.poiid || base.id || "",
      aoiid: miningShape.aoiid || "",
      center:
        miningShape.center || (base.x && base.y ? `${base.x},${base.y}` : ""),
      coordinates: coordinates,
    };
  };

  /**
   * 从搜索结果列表接口响应中提取首个含 AOI 边界的 POI 数据
   * 路径：data.poi_list[i].domain_list 中的 aoi 项
   * @param {Object} data - 接口响应的 data 数据体
   * @returns {Object|null} 标准化 AOI 数据结构
   */
  const parseSearchData = (data) => {
    if (!data || !Array.isArray(data.poi_list)) return null;

    // 遍历搜索结果列表，优先提取第一个包含有效 AOI 区域边界的 POI
    for (const poi of data.poi_list) {
      if (!poi || !Array.isArray(poi.domain_list)) continue;

      const aoiDomain = poi.domain_list.find(
        (item) =>
          item &&
          (item.name === "aoi" || item.name === "roadaoi") &&
          typeof item.value === "string" &&
          item.value.trim().length > 0,
      );
      if (!aoiDomain) continue;

      const coordinates = parseCoordinateString(aoiDomain.value);
      if (!coordinates) continue;

      return {
        name: poi.name || poi.disp_name || "",
        address: poi.address || "",
        tag: poi.tag || poi.classify || poi.newtype || poi.type || "",
        poiid: poi.id || poi.poiid || "",
        aoiid: "",
        center:
          poi.longitude && poi.latitude
            ? `${poi.longitude},${poi.latitude}`
            : "",
        coordinates: coordinates,
      };
    }

    return null;
  };

  /**
   * 统一分发并解析高德响应数据
   * @param {Object} resData - 接口响应的根 JSON 数据
   * @returns {Object|null} 标准化 AOI 数据结构
   */
  const parseResponseToPolygonData = (resData) => {
    // 兼容旧版 status:"1" / status:1 以及新版 SSR code:1 状态码
    const isOk =
      resData?.status === "1" || resData?.status === 1 || resData?.code === 1;
    if (!resData || !isOk) return null;
    const data = resData.data;
    if (!data) return null;

    // 1. 若包含详情接口的 spec.mining_shape.shape，按详情解析
    if (data.spec?.mining_shape?.shape) {
      return parseDetailData(data);
    }

    // 2. 若包含搜索列表 poi_list，按搜索数据解析
    if (Array.isArray(data.poi_list)) {
      return parseSearchData(data);
    }

    return null;
  };

  /**
   * 根据选择的坐标系构建最终的 GeoJSON Feature 对象
   * @param {Object} polygonData - 标准化 AOI 数据
   * @param {boolean} useWgs84 - 是否转换为 WGS-84 坐标系
   * @returns {Object} GeoJSON 格式多边形 Feature 对象
   */
  const buildPolygonGeoJSON = (polygonData, useWgs84) => {
    const coords = useWgs84
      ? convertCoordinatesArray(polygonData.coordinates)
      : polygonData.coordinates;

    return {
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [coords],
      },
      properties: {
        name: polygonData.name,
        address: polygonData.address,
        tag: polygonData.tag,
        poiid: polygonData.poiid,
        aoiid: polygonData.aoiid,
        center: polygonData.center,
        source: "高德地图",
        vertexCount: polygonData.coordinates.length,
      },
      crs: {
        type: "name",
        properties: {
          name: useWgs84 ? "WGS84" : "GCJ02",
        },
      },
    };
  };

  /**
   * 处理拦截到的响应数据：成功提取 AOI 区域后弹出或刷新导出面板
   * @param {Object} resData - 拦截解析得到的响应数据
   */
  const handleAmapResponse = (resData) => {
    const parsed = parseResponseToPolygonData(resData);
    if (!parsed) return;
    currentPolygonData = parsed;
    displayPolygonPanel();
  };

  // ========== 样式 ==========

  const PANEL_CLASS = "amap-tools-polygon-panel";
  const panelStyle = document.createElement("style");
  panelStyle.innerHTML =
    `
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` {
            position: fixed !important;
            z-index: 2147483000 !important;
            box-sizing: border-box !important;
            width: 300px !important;
            max-width: min(300px, 100vw - 24px) !important;
            padding: 10px 12px !important;
            margin: 0 !important;
            border: 1px solid #2196F3 !important;
            border-radius: 6px !important;
            background: #fff !important;
            box-shadow: 0 2px 8px rgba(33, 150, 243, .18) !important;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
            font-size: 13px !important;
            line-height: 1.45 !important;
            font-weight: normal !important;
            color: #333 !important;
            text-align: left !important;
            cursor: move !important;
            -webkit-font-smoothing: antialiased;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` *,
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` *::before,
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` *::after {
            box-sizing: border-box !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-close-btn {
            position: absolute !important;
            top: 4px !important;
            right: 6px !important;
            width: auto !important;
            height: auto !important;
            margin: 0 !important;
            padding: 0 4px !important;
            background: transparent !important;
            color: #999 !important;
            border: none !important;
            font-size: 20px !important;
            line-height: 1 !important;
            font-weight: normal !important;
            cursor: pointer !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-title {
            margin: 0 0 8px !important;
            padding: 0 20px 0 0 !important;
            color: #1565C0 !important;
            font-size: 14px !important;
            font-weight: 600 !important;
            line-height: 1.4 !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-info {
            margin: 0 0 4px !important;
            padding: 0 !important;
            font-size: 12px !important;
            color: #666 !important;
            line-height: 1.5 !important;
            word-break: break-all !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-info strong {
            color: #333 !important;
            font-weight: 600 !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-divider {
            border: none !important;
            border-top: 1px solid #e0e0e0 !important;
            margin: 8px 0 !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-crs-row {
            display: flex !important;
            flex-direction: row !important;
            align-items: center !important;
            gap: 8px !important;
            margin: 0 0 8px !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-crs-row label {
            display: inline-flex !important;
            align-items: center !important;
            margin: 0 !important;
            padding: 0 !important;
            font-size: 12px !important;
            cursor: pointer !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-crs-row input[type="radio"] {
            width: 14px !important;
            height: 14px !important;
            min-width: 14px !important;
            margin: 0 4px 0 0 !important;
            cursor: pointer !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-actions {
            display: flex !important;
            flex-direction: row !important;
            gap: 6px !important;
            margin: 0 !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-actions button {
            flex: 1 1 50% !important;
            min-width: 0 !important;
            margin: 0 !important;
            padding: 6px 10px !important;
            font-size: 12px !important;
            font-weight: normal !important;
            line-height: 1.3 !important;
            color: #fff !important;
            background: #2196F3 !important;
            border: 1px solid #1E88E5 !important;
            border-radius: 3px !important;
            cursor: pointer !important;
        }
        #polygonExportPanel.` +
    PANEL_CLASS +
    ` .polygon-actions button:hover {
            background: #1E88E5 !important;
        }

        /* 页面中间顶部 Toast 提示 */
        .amap-tools-toast {
            position: fixed !important;
            top: 24px !important;
            left: 50% !important;
            transform: translateX(-50%) translateY(-20px) !important;
            z-index: 2147483647 !important;
            padding: 8px 18px !important;
            background: rgba(33, 150, 243, 0.95) !important;
            color: #fff !important;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
            font-size: 13px !important;
            font-weight: 500 !important;
            border-radius: 20px !important;
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2) !important;
            opacity: 0 !important;
            transition: all 0.25s cubic-bezier(0.215, 0.61, 0.355, 1) !important;
            pointer-events: none !important;
            backdrop-filter: blur(4px) !important;
        }
        .amap-tools-toast.show {
            opacity: 1 !important;
            transform: translateX(-50%) translateY(0) !important;
        }
    `;
  document.head.appendChild(panelStyle);

  // ========== 网络请求拦截 ==========

  // 拦截 XMLHttpRequest 请求
  ((open) => {
    XMLHttpRequest.prototype.open = function (
      method,
      url,
      async,
      user,
      password,
    ) {
      // 匹配到目标 AOI 接口后监听完成事件
      if (isTargetAoiUrl(url)) {
        this.addEventListener("load", () => {
          if (this.readyState === 4 && this.status === 200) {
            try {
              handleAmapResponse(JSON.parse(this.responseText));
            } catch (e) {
              console.error("[AmapTools] 解析数据失败", e);
            }
          }
        });
      }
      return open.apply(this, arguments);
    };
  })(XMLHttpRequest.prototype.open);

  // 拦截 fetch 请求
  ((origFetch) => {
    window.fetch = function (input, init) {
      return origFetch.apply(this, arguments).then((res) => {
        let url = "";
        try {
          if (typeof input === "string") url = input;
          else if (input && input.url) url = input.url;
        } catch (e) {
          /* ignore */
        }
        // 匹配到目标 AOI 接口后异步读取 JSON 响应
        if (url && isTargetAoiUrl(url)) {
          res
            .clone()
            .json()
            .then((jsonData) => {
              handleAmapResponse(jsonData);
            })
            .catch(() => {
              /* 非 JSON 响应忽略 */
            });
        }
        return res;
      });
    };
  })(window.fetch);

  // 检测验证码弹窗时隐藏面板（避免遮挡验证）
  const VERIFY_SELECTORS = [
    '[class*="geetest"]',
    '[class*="gcaptcha"]',
    '[id*="gt-"]',
    '[class*="captcha"]',
    '[class*="verify"]',
  ];
  const verifyObserver = new MutationObserver(() => {
    const panel = document.getElementById("polygonExportPanel");
    if (!panel) return;
    const hasVerify = VERIFY_SELECTORS.some((sel) => {
      try {
        return document.querySelector(sel);
      } catch (_) {
        return false;
      }
    });
    panel.style.visibility = hasVerify ? "hidden" : "visible";
  });
  if (document.body) {
    verifyObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ========== UI 面板 ==========

  /** 创建或刷新区域导出面板 */
  const displayPolygonPanel = () => {
    if (!currentPolygonData) return;

    const existingDiv = document.getElementById("polygonExportPanel");
    if (existingDiv) {
      existingDiv.remove();
    }

    const panel = document.createElement("div");
    panel.id = "polygonExportPanel";
    panel.className = PANEL_CLASS;

    // 面板初始或记忆位置
    if (polygonPanelPosition.left && polygonPanelPosition.top) {
      panel.style.left = `${polygonPanelPosition.left}px`;
      panel.style.top = `${polygonPanelPosition.top}px`;
    } else {
      panel.style.right = "20px";
      panel.style.top = "100px";
    }

    // 关闭按钮
    const closeBtn = document.createElement("button");
    closeBtn.className = "polygon-close-btn";
    closeBtn.innerText = "\u00d7";
    closeBtn.onclick = () => {
      panel.remove();
    };
    panel.appendChild(closeBtn);

    // 标题
    const title = document.createElement("div");
    title.className = "polygon-title";
    title.innerText = "📍 " + currentPolygonData.name;
    panel.appendChild(title);

    // 信息展示项列表
    const infoItems = [
      { label: "地址", value: currentPolygonData.address },
      { label: "分类", value: currentPolygonData.tag },
      {
        label: "顶点数",
        value: currentPolygonData.coordinates.length + " 个",
      },
      { label: "POI ID", value: currentPolygonData.poiid },
    ];

    infoItems.forEach((item) => {
      if (!item.value) return;
      const p = document.createElement("div");
      p.className = "polygon-info";
      const strong = document.createElement("strong");
      strong.innerText = item.label + "：";
      p.appendChild(strong);
      p.appendChild(document.createTextNode(item.value));
      panel.appendChild(p);
    });

    // 分割线
    const divider = document.createElement("hr");
    divider.className = "polygon-divider";
    panel.appendChild(divider);

    // 坐标系选择标题
    const crsTitle = document.createElement("div");
    crsTitle.className = "polygon-info";
    const crsTitleStrong = document.createElement("strong");
    crsTitleStrong.innerText = "坐标系：";
    crsTitle.appendChild(crsTitleStrong);
    panel.appendChild(crsTitle);

    // 坐标系单选选项行
    const crsRow = document.createElement("div");
    crsRow.className = "polygon-crs-row";
    const crsFormatName = "amap-tools-polygon-crs";
    // WGS-84 默认选中且放在首位
    [
      { name: "WGS-84（GPS）", value: "wgs84" },
      { name: "GCJ-02（原始）", value: "gcj02" },
    ].forEach((crs, i) => {
      const lab = document.createElement("label");
      const rad = document.createElement("input");
      rad.type = "radio";
      rad.name = crsFormatName;
      rad.value = crs.value;
      if (i === 0) rad.checked = true;
      lab.appendChild(rad);
      lab.appendChild(document.createTextNode(crs.name));
      crsRow.appendChild(lab);
    });
    panel.appendChild(crsRow);

    /**
     * 获取当前面板中选中的坐标系
     * @returns {string} "wgs84" 或 "gcj02"
     */
    const getSelectedCrs = () => {
      const checked = panel.querySelector(
        'input[name="' + crsFormatName + '"]:checked',
      );
      return checked ? checked.value : "wgs84";
    };

    /**
     * 构建当前待导出的 GeoJSON 数据
     * @returns {Object} GeoJSON 数据对象
     */
    const buildExportData = () => {
      const useWgs84 = getSelectedCrs() === "wgs84";
      return buildPolygonGeoJSON(currentPolygonData, useWgs84);
    };

    // 操作按钮行（复制与下载）
    const actionsRow = document.createElement("div");
    actionsRow.className = "polygon-actions";

    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.innerText = "复制 GeoJSON";
    btnCopy.onclick = () => {
      const geoJSON = buildExportData();
      copyTextToClipboard(JSON.stringify(geoJSON, null, 2)).then(() => {
        showToast("✓ GeoJSON 坐标数据已复制到剪贴板");
      });
    };

    const btnDl = document.createElement("button");
    btnDl.type = "button";
    btnDl.innerText = "下载 GeoJSON";
    btnDl.onclick = () => {
      const geoJSON = buildExportData();
      const filename =
        currentPolygonData.name + "_" + getSelectedCrs() + ".geojson";
      downloadFile(
        JSON.stringify(geoJSON, null, 2),
        filename,
        "application/json",
      );
    };

    actionsRow.appendChild(btnCopy);
    actionsRow.appendChild(btnDl);
    panel.appendChild(actionsRow);

    document.body.appendChild(panel);

    // 面板拖拽交互逻辑
    panel.addEventListener("mousedown", (e) => {
      if (e.target.closest("button") || e.target.closest("input")) return;
      isDragging = true;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      panel.style.cursor = "grabbing";

      const handleMouseMove = (ev) => {
        if (isDragging) {
          panel.style.right = "auto";
          const newLeft = Math.max(
            0,
            Math.min(
              window.innerWidth - panel.offsetWidth,
              ev.clientX - dragOffsetX,
            ),
          );
          const newTop = Math.max(
            0,
            Math.min(
              window.innerHeight - panel.offsetHeight,
              ev.clientY - dragOffsetY,
            ),
          );
          panel.style.left = `${newLeft}px`;
          panel.style.top = `${newTop}px`;
          polygonPanelPosition.top = newTop;
          polygonPanelPosition.left = newLeft;
        }
      };

      const handleMouseUp = () => {
        isDragging = false;
        document.body.style.cursor = "";
        panel.style.cursor = "move";
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    });
  };

  // ========== 工具函数 ==========

  let toastTimer = null;

  /**
   * 页面顶部居中 Toast 轻提示
   * @param {string} msg - 提示文本内容
   * @param {number} [duration=2000] - 持续展示毫秒数
   */
  const showToast = (msg, duration = 2000) => {
    let toast = document.querySelector(".amap-tools-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "amap-tools-toast";
      document.body.appendChild(toast);
    }
    toast.innerText = msg;
    void toast.offsetWidth; // 触发重绘以确保平滑过渡动画
    toast.classList.add("show");

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
    }, duration);
  };

  /**
   * 将文本内容复制到系统剪贴板
   * @param {string} text - 待复制文本
   * @returns {Promise<void>} 复制完成 Promise
   */
  const copyTextToClipboard = (text) => {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard
        .writeText(text)
        .then(() => {
          console.log("[AmapTools] 已复制到剪贴板");
        })
        .catch(() => fallbackCopyTextToClipboard(text));
    }
    return fallbackCopyTextToClipboard(text);
  };

  /**
   * 降级方案复制文本到剪贴板（兼容非安全上下文或传统环境）
   * @param {string} text - 待复制文本
   * @returns {Promise<void>}
   */
  const fallbackCopyTextToClipboard = (text) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    let success = false;
    try {
      success = document.execCommand("copy");
      if (success) {
        console.log("[AmapTools] 降级复制成功");
      }
    } catch (err) {
      console.error("[AmapTools] 复制失败", err);
    }
    document.body.removeChild(textarea);
    return success ? Promise.resolve() : Promise.reject(new Error("复制失败"));
  };

  /**
   * 触发浏览器下载文件
   * @param {string} content - 文件内容字符串
   * @param {string} filename - 保存的文件名
   * @param {string} mimeType - MIME 类型
   */
  const downloadFile = (content, filename, mimeType) => {
    const blob = new Blob([content], {
      type: mimeType || "application/octet-stream",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  };
})();
