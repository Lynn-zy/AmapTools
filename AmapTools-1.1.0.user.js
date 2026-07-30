// ==UserScript==
// @name         AmapTools
// @description  高德地图扩展工具。搜索地点（小区、学校、园区等）后，点击详情即可将 AOI 区域边界导出为 GeoJSON 格式，支持 GCJ-02 / WGS-84 坐标系切换。
// @version      2.0.0
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

    let currentPolygonData = null; // 当前拦截到的 AOI 区域数据
    let polygonPanelPosition = { left: null, top: null }; // 面板位置记忆
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // ========== 接口匹配 ==========

    /** 判断 URL 是否为 POI 详情接口（兼容新旧版） */
    function isDetailUrl(url) {
        const u = String(url || "");
        return (
            u.includes("/detail/get/detail") ||
            u.includes("/ssr/api/getPoiDetail")
        );
    }

    // ========== GCJ-02 → WGS-84 坐标转换 ==========

    const GCJ_A = 6378245.0;
    const GCJ_EE = 0.00669342162296594;

    /** 判断坐标是否在中国境外（境外无需转换） */
    function isOutOfChina(lng, lat) {
        return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
    }

    /** 纬度偏移量计算 */
    function transformLat(x, y) {
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
            ((20.0 * Math.sin(y * Math.PI) +
                40.0 * Math.sin((y / 3.0) * Math.PI)) *
                2.0) /
            3.0;
        ret +=
            ((160.0 * Math.sin((y / 12.0) * Math.PI) +
                320 * Math.sin((y * Math.PI) / 30.0)) *
                2.0) /
            3.0;
        return ret;
    }

    /** 经度偏移量计算 */
    function transformLng(x, y) {
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
            ((20.0 * Math.sin(x * Math.PI) +
                40.0 * Math.sin((x / 3.0) * Math.PI)) *
                2.0) /
            3.0;
        ret +=
            ((150.0 * Math.sin((x / 12.0) * Math.PI) +
                300.0 * Math.sin((x / 30.0) * Math.PI)) *
                2.0) /
            3.0;
        return ret;
    }

    /** 将单个 GCJ-02 坐标转换为 WGS-84 */
    function gcj02ToWgs84(lng, lat) {
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
        dlng =
            (dlng * 180.0) / ((GCJ_A / sqrtmagic) * Math.cos(radlat) * Math.PI);
        return [lng - dlng, lat - dlat];
    }

    /** 批量转换坐标数组 [[lng, lat], ...] 从 GCJ-02 到 WGS-84 */
    function convertCoordinatesArray(coordinates) {
        return coordinates.map(function (coord) {
            return gcj02ToWgs84(coord[0], coord[1]);
        });
    }

    // ========== AOI 区域边界解析 ==========

    /**
     * 从详情接口响应中提取 AOI 边界数据
     * 字段路径：data.spec.mining_shape.shape（"lng,lat;lng,lat;..." 格式）
     */
    function parseDetailToPolygonGeoJSON(detailData) {
        // 兼容旧版 status:"1" 和新版 SSR code:1 两种状态字段
        const isOk = detailData?.status === "1" || detailData?.code === 1;
        if (!detailData || !isOk) return null;
        const data = detailData.data;
        if (!data) return null;

        // 提取边界坐标字符串
        const shapeStr = data.spec?.mining_shape?.shape;
        if (!shapeStr || typeof shapeStr !== "string") return null;

        // 解析坐标字符串为坐标数组
        const coordinates = [];
        shapeStr.split(";").forEach(function (seg) {
            const parts = seg.split(",").map(Number);
            if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                coordinates.push([parts[0], parts[1]]);
            }
        });

        if (coordinates.length < 3) return null;

        // 确保多边形闭合（首尾坐标相同）
        const first = coordinates[0];
        const last = coordinates[coordinates.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
            coordinates.push([first[0], first[1]]);
        }

        // 提取 POI 基本信息
        const base = data.base || {};
        const miningShape = data.spec.mining_shape;

        return {
            name: base.name || "",
            address: base.address || "",
            tag: base.tag || base.classify || "",
            poiid: base.poiid || "",
            aoiid: miningShape.aoiid || "",
            center: miningShape.center || "",
            coordinates: coordinates,
        };
    }

    /** 根据选择的坐标系构建最终的 GeoJSON 对象 */
    function buildPolygonGeoJSON(polygonData, useWgs84) {
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
    }

    /** 处理详情接口的响应数据：解析边界并弹出导出面板 */
    function handleDetailResponse(detailData) {
        const parsed = parseDetailToPolygonGeoJSON(detailData);
        if (!parsed) return;
        currentPolygonData = parsed;
        displayPolygonPanel();
    }

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
    `;
    document.head.appendChild(panelStyle);

    // ========== 网络请求拦截 ==========

    // 拦截 XMLHttpRequest 请求
    (function (open) {
        XMLHttpRequest.prototype.open = function (
            method,
            url,
            async,
            user,
            password,
        ) {
            if (isDetailUrl(url)) {
                this.addEventListener("load", function () {
                    if (this.readyState === 4 && this.status === 200) {
                        try {
                            handleDetailResponse(JSON.parse(this.responseText));
                        } catch (e) {
                            console.error("[AmapTools] 解析详情数据失败", e);
                        }
                    }
                });
            }
            open.apply(this, arguments);
        };
    })(XMLHttpRequest.prototype.open);

    // 拦截 fetch 请求
    (function (origFetch) {
        window.fetch = function (input, init) {
            return origFetch.apply(this, arguments).then(function (res) {
                var url = "";
                try {
                    if (typeof input === "string") url = input;
                    else if (input && input.url) url = input.url;
                } catch (e) {
                    /* ignore */
                }
                if (url && isDetailUrl(url)) {
                    res.clone()
                        .json()
                        .then(function (detailData) {
                            handleDetailResponse(detailData);
                        })
                        .catch(function () {
                            /* 非 JSON 响应 */
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
    const verifyObserver = new MutationObserver(function () {
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

    /** 创建区域导出面板 */
    function displayPolygonPanel() {
        if (!currentPolygonData) return;

        const existingDiv = document.getElementById("polygonExportPanel");
        if (existingDiv) {
            existingDiv.remove();
        }

        const panel = document.createElement("div");
        panel.id = "polygonExportPanel";
        panel.className = PANEL_CLASS;

        // 面板位置
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
        closeBtn.onclick = function () {
            panel.remove();
        };
        panel.appendChild(closeBtn);

        // 标题
        const title = document.createElement("div");
        title.className = "polygon-title";
        title.innerText = "\u25B3 " + currentPolygonData.name;
        panel.appendChild(title);

        // 信息展示
        const infoItems = [
            { label: "地址", value: currentPolygonData.address },
            { label: "分类", value: currentPolygonData.tag },
            {
                label: "顶点数",
                value: currentPolygonData.coordinates.length + " 个",
            },
            { label: "POI ID", value: currentPolygonData.poiid },
        ];

        infoItems.forEach(function (item) {
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

        // 坐标系选择
        const crsTitle = document.createElement("div");
        crsTitle.className = "polygon-info";
        const crsTitleStrong = document.createElement("strong");
        crsTitleStrong.innerText = "坐标系：";
        crsTitle.appendChild(crsTitleStrong);
        panel.appendChild(crsTitle);

        const crsRow = document.createElement("div");
        crsRow.className = "polygon-crs-row";
        const crsFormatName = "amap-tools-polygon-crs";
        // WGS-84 默认选中且放在首位
        [
            { name: "WGS-84（GPS）", value: "wgs84" },
            { name: "GCJ-02（原始）", value: "gcj02" },
        ].forEach(function (crs, i) {
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

        /** 获取当前选择的坐标系 */
        function getSelectedCrs() {
            const checked = panel.querySelector(
                'input[name="' + crsFormatName + '"]:checked',
            );
            return checked ? checked.value : "wgs84";
        }

        /** 构建导出数据 */
        function buildExportData() {
            const useWgs84 = getSelectedCrs() === "wgs84";
            return buildPolygonGeoJSON(currentPolygonData, useWgs84);
        }

        // 操作按钮
        const actionsRow = document.createElement("div");
        actionsRow.className = "polygon-actions";

        const btnCopy = document.createElement("button");
        btnCopy.type = "button";
        btnCopy.innerText = "复制 GeoJSON";
        btnCopy.onclick = function () {
            const geoJSON = buildExportData();
            copyTextToClipboard(JSON.stringify(geoJSON, null, 2));
        };

        const btnDl = document.createElement("button");
        btnDl.type = "button";
        btnDl.innerText = "下载 GeoJSON";
        btnDl.onclick = function () {
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

        // 拖拽功能
        panel.addEventListener("mousedown", function (e) {
            if (e.target.closest("button") || e.target.closest("input")) return;
            isDragging = true;
            const rect = panel.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            panel.style.cursor = "grabbing";

            function handleMouseMove(ev) {
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
            }

            function handleMouseUp() {
                isDragging = false;
                document.body.style.cursor = "";
                panel.style.cursor = "move";
                document.removeEventListener("mousemove", handleMouseMove);
                document.removeEventListener("mouseup", handleMouseUp);
            }

            document.addEventListener("mousemove", handleMouseMove);
            document.addEventListener("mouseup", handleMouseUp);
        });
    }

    // ========== 工具函数 ==========

    /** 复制文本到剪贴板 */
    function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard
                .writeText(text)
                .then(function () {
                    console.log("已复制到剪贴板");
                })
                .catch(function () {
                    fallbackCopyTextToClipboard(text);
                });
        }
        fallbackCopyTextToClipboard(text);
        return Promise.resolve();
    }

    /** 降级复制方案（兼容旧浏览器） */
    function fallbackCopyTextToClipboard(text) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand("copy");
            console.log("已复制到剪贴板");
        } catch (err) {
            console.error("复制失败", err);
        }
        document.body.removeChild(textarea);
    }

    /** 通用下载函数 */
    function downloadFile(content, filename, mimeType) {
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
    }
})();
