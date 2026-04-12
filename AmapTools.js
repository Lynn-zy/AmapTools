// ==UserScript==
// @name         AmapTools
// @description  一款高德地图扩展工具。拦截高德地图（驾车、公交、步行）路线规划接口数据，将其转换成GeoJSON/KML/GPX格式，并提供复制与下载。
// @version      1.1.0
// @author       DD1024z
// @namespace    https://github.com/10D24D/AmapTools/
// @supportURL   https://github.com/10D24D/AmapTools/
// @match        https://www.amap.com/*
// @match        https://ditu.amap.com/*
// @match        https://www.gaode.com/*
// @icon         https://a.amap.com/pc/static/favicon.ico
// @license      MIT
// @grant        none
// @downloadURL  https://update.greasyfork.org/scripts/507634/AmapTools.user.js
// @updateURL    https://update.greasyfork.org/scripts/507634/AmapTools.user.js
// ==/UserScript==

(function () {
    'use strict';

    let responseData = null; // 拦截到的接口数据
    let routeType = ''; // 当前路线类型（驾车、公交或步行）
    let listGeoJSON = []
    let currentGeoJSON = {}
    let selectedPathIndex = -1;
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let panelPosition = { left: null, top: null }; // 保存面板位置

    const directionMap = {
        "driving": "驾车",
        "transit": "公交",
        "walking": "步行",
    }
    const uriMap = {
        "driving": "/service/autoNavigat",
        "transit": "/service/nav/bus",
        "walking": "/v3/direction/walking",
    }
    /** 新版 PC SSR 路线接口（与旧版 path_list / nav/bus 并存） */
    const ssrApi = {
        car: "getCarRoutePlan",
        bus: "getBusRoutePlan",
    };

    function isRoutePlanUrl(url) {
        const u = String(url || "");
        return u.includes(uriMap.driving) || u.includes(uriMap.transit)
            || u.includes(ssrApi.car) || u.includes(ssrApi.bus);
    }

    function routeTypeFromPlanUrl(url) {
        const u = String(url || "");
        if (u.includes(ssrApi.car) || u.includes(uriMap.driving)) return directionMap.driving;
        if (u.includes(ssrApi.bus) || u.includes(uriMap.transit)) return directionMap.transit;
        return "";
    }

    /** 将 "lng,lat;lng,lat" 折线追加到 coordinates */
    function appendPolylineSegments(coordinates, polylineStr) {
        if (!polylineStr || typeof polylineStr !== "string") return;
        polylineStr.split(";").forEach(function (seg) {
            const parts = seg.split(",").map(Number);
            if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                coordinates.push([parts[0], parts[1]]);
            }
        });
    }

    /**
     * 与页面内高德原生路线列表联动。
     * 新版 PC SSR 使用 CSS Module（类名带 hash），只匹配稳定子串；
     * 驾车/步行：CarOrWalkRoutePlanItem_routePlanItem__；公交：BusRoutePlanItem_busRoutePlanItem__。
     * 旧版仍用 #plantitle_i。
     */
    function syncAmapNativeRouteSelection(routeIndex) {
        if (routeIndex < 0) return;

        function tryClick(selector) {
            const nodes = document.querySelectorAll(selector);
            if (!nodes.length || routeIndex >= nodes.length) return false;
            try {
                nodes[routeIndex].click();
                return true;
            } catch (e) {
                return false;
            }
        }

        if (routeType === directionMap.driving || routeType === directionMap.walking) {
            if (tryClick('[class*="CarOrWalkRoutePlanItem_routePlanItem__"]')) return;
        } else if (routeType === directionMap.transit) {
            // 新版 SSR 公交卡片类名为 BusRoutePlanItem_busRoutePlanItem__（非 routePlanItem）
            const routeContent = document.querySelector('[class*="RoutePlanContainer_routeContent__"]');
            if (routeContent) {
                const inPanel = routeContent.querySelectorAll('[class*="BusRoutePlanItem_busRoutePlanItem__"]');
                if (inPanel.length && routeIndex < inPanel.length) {
                    try {
                        inPanel[routeIndex].click();
                        return;
                    } catch (e) { /* ignore */ }
                }
            }
            if (tryClick('[class*="BusRoutePlanItem_busRoutePlanItem__"]')) return;
        }

        if (tryClick('[class*="CarOrWalkRoutePlanItem_routePlanItem__"]')) return;
        if (tryClick('[class*="BusRoutePlanItem_busRoutePlanItem__"]')) return;

        const legacy = document.getElementById("plantitle_" + routeIndex);
        if (legacy) {
            document.querySelectorAll(".planTitle.open").forEach(function (el) {
                el.classList.remove("open");
            });
            legacy.classList.add("open");
            try {
                legacy.click();
            } catch (e2) { /* ignore */ }
        }
    }

    /**
     * 与页面内高德原生「出行方式」切换联动（驾车 / 公交 / 步行）。
     * 新版 SSR：NavigationTypeSelector 下三个 iconWrapper；旧版仍用 #carTab #busTab #walkTab。
     */
    function syncAmapNativeModeSelection(modeIndex) {
        if (modeIndex < 0 || modeIndex > 2) return;

        function tryClickNode(el) {
            if (!el) return false;
            try {
                el.click();
                return true;
            } catch (e) {
                return false;
            }
        }

        function tryClickWrapperList(nodes) {
            if (!nodes || nodes.length <= modeIndex) return false;
            return tryClickNode(nodes[modeIndex]);
        }

        const containers = document.querySelectorAll('[class*="NavigationTypeSelector_container__"]');
        for (let c = 0; c < containers.length; c++) {
            const wrappers = containers[c].querySelectorAll('[class*="NavigationTypeSelector_iconWrapper__"]');
            if (wrappers.length >= 3 && tryClickWrapperList(wrappers)) return;
        }

        const globalWrappers = document.querySelectorAll('[class*="NavigationTypeSelector_iconWrapper__"]');
        if (globalWrappers.length >= 3 && tryClickWrapperList(globalWrappers)) return;

        const altLabels = ['驾车', '公交', '步行'];
        const scope =
            document.querySelector('[class*="DirectionIndexContent_directionIndexPage"]') ||
            document.querySelector('[class*="DirectionIndexContent_"]') ||
            document.body;
        const img = scope.querySelector('img[alt="' + altLabels[modeIndex] + '"]');
        if (img) {
            const wrap = img.closest('[class*="NavigationTypeSelector_iconWrapper"]');
            if (tryClickNode(wrap)) return;
        }

        const legacyIds = ['carTab', 'busTab', 'walkTab'];
        const legacy = document.getElementById(legacyIds[modeIndex]);
        tryClickNode(legacy);
    }

    // 样式封装（新版站点全局样式会覆盖简单 #id 规则，需提高特异性并做隔离）
    const PANEL_CLASS = 'amap-tools-route-panel';
    const style = document.createElement('style');
    style.innerHTML = `
        #routeOptions.` + PANEL_CLASS + ` {
            position: fixed !important;
            z-index: 2147483000 !important;
            box-sizing: border-box !important;
            width: 300px !important;
            max-width: min(300px, 100vw - 24px) !important;
            padding: 10px 12px !important;
            margin: 0 !important;
            border: 1px solid #ccc !important;
            border-radius: 6px !important;
            background: #fff !important;
            box-shadow: 0 2px 8px rgba(0, 0, 0, .12) !important;
            font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
            font-size: 13px !important;
            line-height: 1.45 !important;
            font-weight: normal !important;
            color: #333 !important;
            text-align: left !important;
            cursor: move !important;
            -webkit-font-smoothing: antialiased;
        }
        #routeOptions.` + PANEL_CLASS + ` *,
        #routeOptions.` + PANEL_CLASS + ` *::before,
        #routeOptions.` + PANEL_CLASS + ` *::after {
            box-sizing: border-box !important;
        }
        #routeOptions.` + PANEL_CLASS + ` #closeBtn {
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
        #routeOptions.` + PANEL_CLASS + ` h3 {
            margin: 6px 0 6px !important;
            padding: 0 !important;
            color: #333 !important;
            font-size: 13px !important;
            font-weight: 600 !important;
            line-height: 1.4 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` label {
            display: block !important;
            margin: 0 0 8px !important;
            padding: 0 !important;
            font-size: 13px !important;
            font-weight: normal !important;
            color: #333 !important;
            line-height: 1.45 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` input[type="radio"] {
            width: 14px !important;
            height: 14px !important;
            min-width: 14px !important;
            min-height: 14px !important;
            margin: 0 6px 0 0 !important;
            padding: 0 !important;
            vertical-align: -2px !important;
            cursor: pointer !important;
        }
        #routeOptions.` + PANEL_CLASS + ` button:not(#closeBtn) {
            margin: 0 !important;
            padding: 5px 10px !important;
            font-size: 12px !important;
            font-weight: normal !important;
            line-height: 1.3 !important;
            color: #333 !important;
            background: #f5f5f5 !important;
            border: 1px solid #ccc !important;
            border-radius: 3px !important;
            cursor: pointer !important;
        }
        #routeOptions.` + PANEL_CLASS + ` button:not(#closeBtn):hover {
            background: #eee !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-mode-row {
            display: flex !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 6px !important;
            margin: 0 !important;
            padding: 0 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-block {
            margin-top: 8px !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-format-row {
            display: flex !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 8px 10px !important;
            margin: 0 0 8px !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-format-title {
            flex: 0 0 auto !important;
            margin: 0 !important;
            font-size: 12px !important;
            color: #555 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-radios {
            display: flex !important;
            flex-direction: row !important;
            flex-wrap: wrap !important;
            align-items: center !important;
            gap: 6px 12px !important;
            flex: 1 1 auto !important;
            min-width: 0 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-radios label {
            display: inline-flex !important;
            flex-direction: row !important;
            align-items: center !important;
            margin: 0 !important;
            padding: 0 !important;
            font-size: 12px !important;
            font-weight: normal !important;
            color: #333 !important;
            cursor: pointer !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-radios input[type="radio"] {
            width: 14px !important;
            height: 14px !important;
            min-width: 14px !important;
            margin: 0 4px 0 0 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-actions {
            display: flex !important;
            flex-direction: row !important;
            gap: 6px !important;
            margin: 0 !important;
        }
        #routeOptions.` + PANEL_CLASS + ` .amap-tools-export-actions button {
            flex: 1 1 50% !important;
            min-width: 0 !important;
        }
    `;
    document.head.appendChild(style);

    // 判断是否为有效的路线接口响应（排除验证码、错误等）
    function isValidRouteResponse(data) {
        if (!data || typeof data !== 'object') return false;
        if (data.status === '0' || data.status === 0) return false;
        if (data.info && /UNAUTH|INVALID|ERROR|验证/i.test(String(data.info))) return false;
        if (routeType === directionMap.driving) {
            const d = data.data;
            if (d?.path_list && d.path_list.length > 0) return true;
            // 新版 getCarRoutePlan：data.route.paths + steps[].polyline
            if (String(d?.status) === "1" && d?.route?.paths && d.route.paths.length > 0) return true;
            return false;
        }
        if (routeType === directionMap.transit) {
            const rl = data.data?.routelist;
            const bl = data.data?.buslist;
            const hasBus = bl && bl.filter(function (r) { return r && r.busindex !== undefined && r.busindex !== null; }).length > 0;
            return !!((rl && rl.length > 0) || hasBus);
        }
        if (routeType === directionMap.walking) {
            return !!(data.route?.paths && data.route.paths.length > 0);
        }
        return false;
    }

    // 拦截 XMLHttpRequest 请求
    (function (open) {
        XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
            if (isRoutePlanUrl(url)) {
                this.addEventListener('load', function () {
                    if (this.readyState === 4 && this.status === 200) {
                        try {
                            routeType = routeTypeFromPlanUrl(url);
                            responseData = JSON.parse(this.responseText);
                            if (!isValidRouteResponse(responseData)) {
                                responseData = null;
                                return;
                            }
                            parseDataToGeoJSON();
                        } catch (e) {
                            responseData = null;
                            console.error('解析路线数据时出错', e);
                        }
                    }
                });

            }
            open.apply(this, arguments);
        };
    })(XMLHttpRequest.prototype.open);

    // 新版页面可能用 fetch 请求 SSR 路线接口，需一并拦截
    (function (origFetch) {
        window.fetch = function (input, init) {
            return origFetch.apply(this, arguments).then(function (res) {
                var url = "";
                try {
                    if (typeof input === "string") url = input;
                    else if (input && input.url) url = input.url;
                } catch (e) { /* ignore */ }
                if (url && isRoutePlanUrl(url)) {
                    res.clone().json().then(function (data) {
                        routeType = routeTypeFromPlanUrl(url);
                        responseData = data;
                        if (!isValidRouteResponse(responseData)) {
                            responseData = null;
                            return;
                        }
                        parseDataToGeoJSON();
                    }).catch(function () { /* 非 JSON */ });
                }
                return res;
            });
        };
    })(window.fetch);

    // 拦截 script 请求
    const observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(function (node) {
                // 动态拦截步行路线的 JSONP 请求
                if (node.tagName === 'SCRIPT' && node.src.includes(uriMap.walking)) {
                    const match = /callback=([^&]+)/.exec(node.src);
                    const callbackName = match ? match[1] : null;
                    if (callbackName && window[callbackName]) {
                        const originalCallback = window[callbackName];
                        window[callbackName] = function (data) {
                            routeType = directionMap.walking;
                            responseData = data;
                            if (!isValidRouteResponse(data)) {
                                responseData = null;
                                if (originalCallback) originalCallback(data);
                                return;
                            }
                            parseDataToGeoJSON();
                            if (originalCallback) {
                                originalCallback(data);
                            }
                        };
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // 检测验证码/人机验证弹窗，出现时隐藏本脚本面板（避免遮挡验证）
    const VERIFY_SELECTORS = ['[class*="geetest"]', '[class*="gcaptcha"]', '[id*="gt-"]', '[class*="captcha"]', '[class*="verify"]'];
    const verifyObserver = new MutationObserver(function () {
        const routePanel = document.getElementById('routeOptions');
        if (!routePanel) return;
        const hasVerify = VERIFY_SELECTORS.some(sel => {
            try { return document.querySelector(sel); } catch (_) { return false; }
        });
        routePanel.style.visibility = hasVerify ? 'hidden' : 'visible';
    });
    if (document.body) {
        verifyObserver.observe(document.body, { childList: true, subtree: true });
    }

    const lineGeoJSONTemplate = {
        type: "Feature",
        geometry: {
            type: "LineString",
            coordinates: []
        },
        properties: {}
    };

    // 初始化一个路线的geojson
    function initLineGeoJSON() {
        return JSON.parse(JSON.stringify(lineGeoJSONTemplate)); // 深拷贝模板对象
    }

    // 将原始数据转换成geojson
    function parseDataToGeoJSON() {
        listGeoJSON = [];
        let pathList = [];

        if (!responseData) {
            console.error('无有效路线数据');
            return;
        }

        if (routeType === directionMap.driving) {
            const inner = responseData.data || {};
            pathList = inner.path_list || [];
            if (pathList.length > 0) {
                // 旧版：path_list + segment.coor
                pathList.forEach((data, index) => {
                    let geoJSON = initLineGeoJSON();
                    geoJSON.properties.duration = Math.ceil(inner.drivetime.split(',')[index] / 60);
                    geoJSON.properties.distance = parseInt(inner.distance.split(',')[index], 10);
                    geoJSON.properties.traffic_lights = parseInt(data.traffic_lights || 0, 10);

                    data.path.forEach((path) => {
                        path.segments.forEach((segment) => {
                            if (segment.coor) {
                                const cleanedCoor = segment.coor.replace(/[\[\]]/g, '');
                                const coorArray = cleanedCoor.split(',').map(Number);
                                for (let k = 0; k < coorArray.length; k += 2) {
                                    const lng = coorArray[k];
                                    const lat = coorArray[k + 1];
                                    if (!isNaN(lng) && !isNaN(lat)) {
                                        geoJSON.geometry.coordinates.push([lng, lat]);
                                    }
                                }
                            }
                        });
                    });

                    listGeoJSON.push(geoJSON);
                });
            } else if (inner.route && inner.route.paths && inner.route.paths.length > 0) {
                // 新版 getCarRoutePlan：与步行类似，roads[].steps[].polyline
                inner.route.paths.forEach(function (path) {
                    let geoJSON = initLineGeoJSON();
                    geoJSON.properties.duration = Math.ceil(parseInt(path.duration, 10) / 60);
                    geoJSON.properties.distance = parseInt(path.distance, 10);
                    geoJSON.properties.traffic_lights = parseInt(path.traffic_lights || 0, 10);
                    (path.roads || []).forEach(function (road) {
                        (road.steps || []).forEach(function (step) {
                            appendPolylineSegments(geoJSON.geometry.coordinates, step.polyline);
                        });
                    });
                    listGeoJSON.push(geoJSON);
                });
            }
        } else if (routeType === directionMap.transit) {
            // 解析公交规划的数据
            if (responseData.data?.routelist && responseData.data.routelist.length > 0) {
                // 如果存在 routelist 则优先处理 routelist
                pathList = responseData.data.routelist;

                // 处理 routelist 数据结构
                pathList.forEach((segment, index) => {
                    let geoJSON = initLineGeoJSON();
                    segment.segments.forEach((subSegment, i) => {
                        subSegment.forEach((element, j) => {
                            // 铁路。拼接起点、途经点和终点坐标
                            if (element[0] === "railway") {
                                // 添加起点坐标
                                const startCoord = element[1].scord.split(' ').map(Number);
                                geoJSON.geometry.coordinates.push(startCoord);

                                // 添加途经点坐标
                                const viaCoords = element[1].viastcord.split(' ').map(Number);
                                for (let k = 0; k < viaCoords.length; k += 2) {
                                    geoJSON.geometry.coordinates.push([viaCoords[k], viaCoords[k + 1]]);
                                }

                                // 添加终点坐标
                                const endCoord = element[1].tcord.split(' ').map(Number);
                                geoJSON.geometry.coordinates.push(endCoord);
                            }
                        });

                    });
                    geoJSON.properties.duration = parseInt(segment.time, 10); // 路程时间（单位：分钟）
                    geoJSON.properties.distance = parseInt(segment.distance, 10); // 路程距离（单位：米）
                    geoJSON.properties.cost = parseFloat(segment.cost); // 花费金额
                    listGeoJSON.push(geoJSON);
                });

            } else {
                // 过滤掉没有 busindex 的公交路线
                pathList = (responseData.data?.buslist || []).filter(route => route.busindex !== undefined);

                pathList.forEach(data => {
                    let geoJSON = initLineGeoJSON();

                    geoJSON.properties.distance = parseInt(data.allLength, 10)
                    geoJSON.properties.duration = Math.ceil(data.expensetime / 60)
                    geoJSON.properties.walk_distance = parseInt(data.allfootlength, 10)
                    geoJSON.properties.expense = Math.ceil(data.expense)
                    geoJSON.properties.expense_currency = data.expense_currency

                    const segmentList = data.segmentlist;
                    let segmentProperties = []

                    segmentList.forEach(segment => {
                        if (!geoJSON.properties.startStation) {
                            geoJSON.properties.startStation = segment.startname + (geoJSON.properties.inport ? '(' + geoJSON.properties.inport + ')' : '');
                        }

                        let importantInfo = {
                            startname: segment.startname ? segment.startname : '',
                            endname: segment.endname ? segment.endname : '',
                            bus_key_name: segment.bus_key_name ? segment.bus_key_name : '',
                            inport_name: (segment.inport && segment.inport.name) ? segment.inport.name : '',
                            outport_name: (segment.outport && segment.outport.name) ? segment.outport.name : '',
                        }
                        segmentProperties.push(importantInfo);

                        // 起点到公交的步行路径
                        if (segment.walk && segment.walk.infolist) {
                            segment.walk.infolist.forEach(info => {
                                const walkCoords = info.coord.split(',').map(Number);
                                for (let i = 0; i < walkCoords.length; i += 2) {
                                    geoJSON.geometry.coordinates.push([walkCoords[i], walkCoords[i + 1]]);
                                }
                            });
                        }
                        // 公交驾驶路线
                        const driverCoords = segment.drivercoord.split(',').map(Number);
                        for (let i = 0; i < driverCoords.length; i += 2) {
                            geoJSON.geometry.coordinates.push([driverCoords[i], driverCoords[i + 1]]);
                        }

                        // 公交换乘路线
                        // if (segment.alterlist && segment.alterlist.length > 0){
                        //     for (let i = 0; i < segment.alterlist.length; i++) {
                        //         const after = segment.alterlist[i];
                        //     }
                        // }
                    });

                    // 到达公交后离终点的步行路径
                    if (data.endwalk && data.endwalk.infolist) {
                        data.endwalk.infolist.forEach(info => {
                            const endwalkCoords = info.coord.split(',').map(Number);
                            for (let i = 0; i < endwalkCoords.length; i += 2) {
                                geoJSON.geometry.coordinates.push([endwalkCoords[i], endwalkCoords[i + 1]]);
                            }
                        });
                    }

                    listGeoJSON.push(geoJSON);
                });
            }

        } else if (routeType === directionMap.walking) {
            // 解析步行规划的数据
            pathList = responseData.route?.paths || [];
            pathList.forEach(path => {
                let geoJSON = initLineGeoJSON()
                geoJSON.properties.distance = parseInt(path.distance, 10)
                geoJSON.properties.duration = Math.ceil(parseInt(path.duration, 10) / 60)
                path.steps.forEach(step => {
                    const coorArray = step.polyline.split(';').map(item => item.split(',').map(Number));
                    coorArray.forEach(coordinate => {
                        if (coordinate.length === 2 && !isNaN(coordinate[0]) && !isNaN(coordinate[1])) {
                            geoJSON.geometry.coordinates.push(coordinate);
                        }
                    });
                });
                listGeoJSON.push(geoJSON);
            });

        } else {
            console.error('未知的数据');
            return;
        }

        if (listGeoJSON.length === 0) return;
        displayRouteOptions();
    }

    // 创建路线选择界面
    function displayRouteOptions() {
        const existingDiv = document.getElementById('routeOptions');
        if (existingDiv) {
            existingDiv.remove();
        }

        const routeDiv = document.createElement('div');
        routeDiv.id = 'routeOptions';
        routeDiv.className = PANEL_CLASS;

        // 检查是否有保存的位置数据
        if (panelPosition.left && panelPosition.top) {
            routeDiv.style.left = `${panelPosition.left}px`;
            routeDiv.style.top = `${panelPosition.top}px`;
        } else {
            // 如果没有保存的位置数据，使用默认位置
            routeDiv.style.right = '20px';
            routeDiv.style.top = '100px';
        }

        // 创建关闭按钮
        const closeBtn = document.createElement('button');
        closeBtn.id = 'closeBtn';
        closeBtn.innerText = '×';
        closeBtn.onclick = function () {
            routeDiv.remove();
        };
        routeDiv.appendChild(closeBtn);

        // 出行方式
        const modeTitle = document.createElement('h3');
        modeTitle.innerText = '出行方式：';
        routeDiv.appendChild(modeTitle);

        const modeSelectionDiv = document.createElement('div');
        modeSelectionDiv.className = 'amap-tools-mode-row';

        const modes = [directionMap.driving, directionMap.transit, directionMap.walking];

        modes.forEach((mode, modeIndex) => {
            const modeLabel = document.createElement('label');
            const modeRadio = document.createElement('input');
            modeLabel.style.marginRight = '5px';
            modeRadio.type = 'radio';
            modeRadio.name = 'modeSelection';
            modeRadio.value = mode;
            modeRadio.onchange = function () {
                syncAmapNativeModeSelection(modeIndex);
            };
            if (mode === routeType) {
                modeRadio.checked = true;
            }

            modeLabel.appendChild(modeRadio);
            modeLabel.appendChild(document.createTextNode(mode));
            modeSelectionDiv.appendChild(modeLabel);
        });

        // 将 modeSelectionDiv 添加到路线选择界面
        routeDiv.appendChild(modeSelectionDiv);

        // 修改原来的标题
        const title = document.createElement('h3');
        title.innerText = `路线列表：`;
        routeDiv.appendChild(title);
        const routeFragment = document.createDocumentFragment();

        // 遍历所有的路线
        listGeoJSON.forEach((geoJSON, index) => {
            const label = document.createElement('label');
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'routeSelection';
            radio.value = index;

            radio.onclick = function () {
                selectedPathIndex = index;
                currentGeoJSON = listGeoJSON[selectedPathIndex];
                syncAmapNativeRouteSelection(index);
            };

            if (index === 0) {
                radio.checked = true;
                selectedPathIndex = 0;
                currentGeoJSON = listGeoJSON[selectedPathIndex];
            }

            const totalDistance = formatDistance(geoJSON.properties.distance);

            const totalTime = formatTime(geoJSON.properties.duration);

            const trafficLights = geoJSON.properties.traffic_lights ? ` | 红绿灯${geoJSON.properties.traffic_lights}个` : '';

            const walkDistance = geoJSON.properties.walk_distance ? ` | 步行${formatDistance(geoJSON.properties.walk_distance)}` : '';

            const expense = geoJSON.properties.expense ? ` | ${Math.ceil(geoJSON.properties.expense)}${geoJSON.properties.expense_currency}` : '';

            label.appendChild(radio);
            label.appendChild(document.createTextNode(`路线${index + 1}：约${totalTime} | ${totalDistance}${trafficLights}${walkDistance}${expense}`));
            routeFragment.appendChild(label);
        });
        routeDiv.appendChild(routeFragment);

        const exportBlock = document.createElement('div');
        exportBlock.className = 'amap-tools-export-block';
        const exportTitle = document.createElement('h3');
        exportTitle.innerText = '导出：';
        exportBlock.appendChild(exportTitle);

        function ensureRouteSelected() {
            if (selectedPathIndex === -1) {
                alert('请先选择一条路线');
                return false;
            }
            currentGeoJSON = listGeoJSON[selectedPathIndex];
            return true;
        }

        const formatRow = document.createElement('div');
        formatRow.className = 'amap-tools-export-format-row';
        const formatTitle = document.createElement('span');
        formatTitle.className = 'amap-tools-export-format-title';
        formatTitle.innerText = '格式：';
        const formatRadios = document.createElement('div');
        formatRadios.className = 'amap-tools-export-radios';
        const exportFormatName = 'amap-tools-export-format';
        ['GeoJSON', 'KML', 'GPX'].forEach(function (fmt, i) {
            const lab = document.createElement('label');
            const rad = document.createElement('input');
            rad.type = 'radio';
            rad.name = exportFormatName;
            rad.value = fmt;
            if (i === 0) rad.checked = true;
            lab.appendChild(rad);
            lab.appendChild(document.createTextNode(fmt));
            formatRadios.appendChild(lab);
        });
        formatRow.appendChild(formatTitle);
        formatRow.appendChild(formatRadios);
        exportBlock.appendChild(formatRow);

        function getSelectedExportFormat() {
            const checked = exportBlock.querySelector('input[name="' + exportFormatName + '"]:checked');
            return checked ? checked.value : 'GeoJSON';
        }

        const actionsRow = document.createElement('div');
        actionsRow.className = 'amap-tools-export-actions';
        const btnCopy = document.createElement('button');
        btnCopy.type = 'button';
        btnCopy.innerText = '复制';
        btnCopy.onclick = function () {
            if (!ensureRouteSelected()) return;
            const payload = buildRouteExportPayload(getSelectedExportFormat(), currentGeoJSON, routeType, selectedPathIndex);
            if (payload) copyTextToClipboard(payload.text);
        };
        const btnDl = document.createElement('button');
        btnDl.type = 'button';
        btnDl.innerText = '下载';
        btnDl.onclick = function () {
            if (!ensureRouteSelected()) return;
            const payload = buildRouteExportPayload(getSelectedExportFormat(), currentGeoJSON, routeType, selectedPathIndex);
            if (payload) downloadFile(payload.text, payload.filename, payload.mime);
        };
        actionsRow.appendChild(btnCopy);
        actionsRow.appendChild(btnDl);
        exportBlock.appendChild(actionsRow);
        routeDiv.appendChild(exportBlock);

        document.body.appendChild(routeDiv);

        // 添加拖拽功能（点击按钮不触发拖拽）
        routeDiv.addEventListener('mousedown', function (e) {
            if (e.target.closest('button') || e.target.closest('input')) return;
            isDragging = true;
            const rect = routeDiv.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            routeDiv.style.cursor = 'grabbing';

            function handleMouseMove(ev) {
                if (isDragging) {
                    routeDiv.style.right = 'auto';
                    const newLeft = Math.max(0, Math.min(window.innerWidth - routeDiv.offsetWidth, ev.clientX - dragOffsetX));
                    const newTop = Math.max(0, Math.min(window.innerHeight - routeDiv.offsetHeight, ev.clientY - dragOffsetY));
                    routeDiv.style.left = `${newLeft}px`;
                    routeDiv.style.top = `${newTop}px`;
                    panelPosition.top = newTop;
                    panelPosition.left = newLeft;
                }
            }

            function handleMouseUp() {
                isDragging = false;
                document.body.style.cursor = '';
                routeDiv.style.cursor = 'move';
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
            }

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
    }

    // 时间格式化：大于60分钟显示小时，大于24小时显示天
    function formatTime(minutes) {
        const mins = Math.max(0, parseInt(minutes, 10) || 0);
        if (mins >= 1440) { // 超过24小时
            const days = Math.floor(mins / 1440);
            const hours = Math.floor((mins % 1440) / 60);
            return `${days}天${hours ? hours + '小时' : ''}`;
        } else if (mins >= 60) { // 超过1小时
            const hours = Math.floor(mins / 60);
            const remainder = mins % 60;
            return `${hours}小时${remainder ? remainder + '分钟' : ''}`;
        }
        return `${mins}分钟`;
    }

    // 格式化距离函数：如果小于1000米，保留米；如果大于等于1000米，转换为公里
    function formatDistance(distanceInMeters) {
        const dist = parseInt(distanceInMeters, 10) || 0;
        if (dist < 1000) {
            return `${dist}米`;
        }
        return `${(dist / 1000).toFixed(1)}公里`;
    }

    function copyTextToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(function () {
                console.log('已复制到剪贴板');
            }).catch(function () {
                fallbackCopyTextToClipboard(text);
            });
        }
        fallbackCopyTextToClipboard(text);
        return Promise.resolve();
    }

    function fallbackCopyTextToClipboard(text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            console.log('已复制到剪贴板');
        } catch (err) {
            console.error('复制失败', err);
        }
        document.body.removeChild(textarea);
    }

    // 通用下载函数
    function downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }

    // GeoJSON 转 KML（用于 Google Earth 等）
    function geoJSONToKML(geoJSON) {
        const coords = geoJSON.geometry?.coordinates || [];
        const coordStr = coords.map(c => c[0] + ',' + c[1] + ',0').join(' ');
        const name = (geoJSON.properties?.distance ? formatDistance(geoJSON.properties.distance) : '') +
            (geoJSON.properties?.duration ? ' / ' + formatTime(geoJSON.properties.duration) : '');
        return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <Placemark>\n      <name>' +
            escapeXml(name) + '</name>\n      <LineString>\n        <coordinates>' + coordStr + '</coordinates>\n      </LineString>\n    </Placemark>\n  </Document>\n</kml>';
    }

    // GeoJSON 转 GPX（用于 GPS 设备、运动 App 等）
    function geoJSONToGPX(geoJSON) {
        const coords = geoJSON.geometry?.coordinates || [];
        const trkpts = coords.map(c => '        <trkpt lat="' + c[1] + '" lon="' + c[0] + '"></trkpt>').join('\n');
        const name = (geoJSON.properties?.distance ? formatDistance(geoJSON.properties.distance) : 'Route') +
            (geoJSON.properties?.duration ? ' / ' + formatTime(geoJSON.properties.duration) : '');
        return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="AmapTools">\n  <trk>\n    <name>' +
            escapeXml(name) + '</name>\n    <trkseg>\n' + trkpts + '\n    </trkseg>\n  </trk>\n</gpx>';
    }

    function escapeXml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }

    function buildRouteExportPayload(fmt, geo, routeTypeStr, pathIdx) {
        const baseName = routeTypeStr + '_路线' + (pathIdx + 1);
        if (fmt === 'GeoJSON') {
            const out = Object.assign({}, geo, { crs: { type: 'name', properties: { name: 'GCJ02' } } });
            return { text: JSON.stringify(out), mime: 'application/json', filename: baseName + '.geojson' };
        }
        if (fmt === 'KML') {
            return { text: geoJSONToKML(geo), mime: 'application/vnd.google-earth.kml+xml', filename: baseName + '.kml' };
        }
        if (fmt === 'GPX') {
            return { text: geoJSONToGPX(geo), mime: 'application/gpx+xml', filename: baseName + '.gpx' };
        }
        return null;
    }

    // AmapLoginAssist - 高德地图支持密码登录、三方登录
    // [clone from MIT code](https://greasyfork.org/zh-CN/scripts/477376-amaploginassist-%E9%AB%98%E5%BE%B7%E5%9C%B0%E5%9B%BE%E6%94%AF%E6%8C%81%E5%AF%86%E7%A0%81%E7%99%BB%E5%BD%95-%E4%B8%89%E6%96%B9%E7%99%BB%E5%BD%95)
    // 新版 Passport UI（JSS 类名 + third-area 默认 none + 链接 display:none）可能不再仅靠 config 展开，
    // 故增加 DOM 兜底：稳定选择器 [id^="third-area"] 与 OAuth href，避免依赖哈希 class。

    const THIRD_LOGIN_STYLE_ID = "amap-tools-third-login-fix";

    function injectThirdLoginStyles() {
        if (document.getElementById(THIRD_LOGIN_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = THIRD_LOGIN_STYLE_ID;
        style.textContent = [
            /* 覆盖 third-area 上 none 与内联 display:none（提高特异性，置于文档末尾） */
            "[id^=\"third-area\"][class*=\"thirdArea\"] { display: flex !important; flex-wrap: wrap !important; align-items: center !important; gap: 8px !important; width: 100% !important; box-sizing: border-box !important; }",
            "[id^=\"third-area\"] span[class*=\"otherAccount\"] { display: inline !important; visibility: visible !important; }",
            "[id^=\"third-area\"] a[href*=\"oauth\"],",
            "[id^=\"third-area\"] a[href*=\"openauth.alipay\"],",
            "[id^=\"third-area\"] a[href*=\"api.weibo.com\"],",
            "[id^=\"third-area\"] a[href*=\"graph.qq.com\"] { display: inline-block !important; visibility: visible !important; }",
        ].join("\n");
        (document.head || document.documentElement).appendChild(style);
    }

    function tryPassportConfig() {
        if (!window.passport || typeof window.passport.config !== "function") return false;
        try {
            window.passport.config({
                loginMode: ["password", "message", "qq", "sina", "taobao", "alipay", "subAccount", "qrcode"],
                loginParams: {
                    dip: 20303,
                },
            });
            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    function refreshThirdLoginUi() {
        injectThirdLoginStyles();
        tryPassportConfig();
    }

    let pollCount = 0;
    const maxPoll = 200;
    const intervalID = setInterval(() => {
        try {
            pollCount++;
            if (window.passport && window.passport.config) {
                refreshThirdLoginUi();
                clearInterval(intervalID);
                return;
            }
            if (pollCount >= maxPoll) {
                clearInterval(intervalID);
            }
        } catch (e) {
            console.error(e);
            clearInterval(intervalID);
        }
    }, 100);

    if (typeof MutationObserver !== "undefined") {
        let moTimer = 0;
        const mo = new MutationObserver(() => {
            if (!document.querySelector("[id^=\"third-area\"]")) return;
            clearTimeout(moTimer);
            moTimer = setTimeout(() => {
                moTimer = 0;
                refreshThirdLoginUi();
            }, 80);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
    }
})();
