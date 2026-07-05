// Canva 批量字号 —— 通过 chrome.debugger 发可信事件操作 Canva 编辑器。
// 流程：逐页 -> 枚举画布内文字元素 -> 点击选中 -> 读当前字号 ->
//        (字号 >= 阈值才改) 聚焦字号框、全选、输入目标值、回车。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全选修饰键：macOS 用 Meta(Cmd)=4，其他平台用 Ctrl=2
const SELECT_ALL_MODIFIER = navigator.userAgent.includes("Mac") ? 4 : 2;

// —— 校对 AI 后端配置 ——
// 后端由 popup 显式传入（provider/apiKey/model）；model 留空时回退到各后端默认值。
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "google/gemini-2.0-flash-exp:free"; // OpenRouter 默认模型
const LOCAL_PROXY_URL = "http://localhost:8787/v1/chat/completions";
const LOCAL_PROXY_MODEL = "gemini-2.5-flash";
const GEMINI_URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_MODEL = "gemini-2.5-flash"; // Gemini AI Studio 默认模型（2.0-flash 已被 Google 下线）

function makeRunner(tabId, port, state) {
  const target = { tabId };
  // 弹窗关闭后 port 断开，postMessage 会抛错；吞掉异常避免污染运行循环
  const send = (type, payload) => {
    try { port.postMessage({ type, ...payload }); } catch (_) {}
  };
  const log = (text) => send("log", { text });

  const cmd = (method, params = {}) =>
    chrome.debugger.sendCommand(target, method, params);

  // 在页面主框架执行表达式，返回可序列化的值
  async function evaluate(expression) {
    const res = await cmd("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res && res.exceptionDetails) {
      throw new Error("页面表达式异常: " + (res.exceptionDetails.text || ""));
    }
    return res.result.value;
  }

  async function clickAt(x, y) {
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await cmd("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await cmd("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
  }

  async function typeText(text) {
    await cmd("Input.insertText", { text });
  }

  async function pressEnter() {
    await cmd("Input.dispatchKeyEvent", {
      type: "keyDown", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r",
    });
    await cmd("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
  }

  async function pressEscape() {
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }

  async function doubleClickAt(x, y) {
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 2 });
    await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 2 });
  }

  // 全选：macOS = Cmd+A，其他平台 = Ctrl+A（见 SELECT_ALL_MODIFIER）
  async function pressSelectAll() {
    await cmd("Input.dispatchKeyEvent", {
      type: "keyDown", key: "a", code: "KeyA",
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: SELECT_ALL_MODIFIER,
    });
    await cmd("Input.dispatchKeyEvent", {
      type: "keyUp", key: "a", code: "KeyA",
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: SELECT_ALL_MODIFIER,
    });
  }

  // 当前页码与总页数，形如 "3 / 18"
  // 遍历所有匹配的叶子节点，过滤掉 current>total 的（如 "16 / 9" 比例文本）
  function readPageInfo() {
    return evaluate(`(() => {
      const els = [...document.querySelectorAll('*')].filter(e =>
        e.children.length === 0 && /^\\d+\\s*\\/\\s*\\d+$/.test((e.textContent||'').trim()));
      for (const el of els) {
        const m = el.textContent.trim().match(/(\\d+)\\s*\\/\\s*(\\d+)/);
        const cur = +m[1], tot = +m[2];
        if (cur >= 1 && tot >= 1 && cur <= tot) return { current: cur, total: tot };
      }
      return null;
    })()`);
  }

  // 底部控制条上的 "Pages" 视图切换按钮（纯文本、无 aria-label，与 Zoom 滑块同排）
  // 中文界面实测文本为 "页面"，非直译，需双语候选匹配
  function findPagesViewToggle() {
    return evaluate(`(() => {
      const el = [...document.querySelectorAll('button,div[role="button"]')]
        .find(e => ['Pages','页面'].includes((e.textContent||'').trim()) && e.getBoundingClientRect().top > innerHeight - 100);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
  }

  // 视频/Reel 设计默认的 Duration/时间轴视图没有"当前/总页"文字，readPageInfo() 恒返回 null，
  // 导致 runAddPages/runPlaceVideos 的总页数统计与新建确认逻辑失效。
  // 2026-07 实测：底部原生 "Pages" 视图切换按钮点开后会显示堆叠全部页列表+"N / 总数"文字，
  // 且可再点一次切回原视图（确认可逆）。仅用它读一次总页数，读完立刻切回，避免视图切换
  // 影响其他依赖 Duration 布局的操作（如 openCaptionsPanel 的画布点击坐标）。
  async function readPageInfoRobust() {
    const direct = await readPageInfo();
    if (direct) return direct;
    const toggle = await findPagesViewToggle();
    if (!toggle) return null;
    await clickAt(toggle.cx, toggle.cy);
    await sleep(600);
    const info = await readPageInfo();
    const toggleBack = await findPagesViewToggle();
    if (toggleBack) {
      await clickAt(toggleBack.cx, toggleBack.cy);
      await sleep(600);
    }
    return info;
  }

  // 画布矩形获取表达式：aria-label="Canvas content" 是英文硬编码，中文界面实测为
  // "画布内容"，且页面上可能存在多个 [role="application"]（含 aria-label 为空的无关节点）。
  // 改用几何启发式，完全不依赖 aria-label 文本：枚举全部 [role="application"]，各自沿
  // 祖先链找第一个有真实尺寸(w>5&&h>5)的祖先（该角色节点自身 rect 恒为 0x0，是无障碍镜像
  // 树节点，不在可视渲染树里），取面积最大的一个即为真实画布框。已在中英文两套真实设计上
  // 验证一致。.jXCxjw 混淆 class 会随 Canva 构建变化而失效（且实测在不同设计间行为不稳定，
  // 曾指向无关缩略图导致文字枚举全部清空），仅作最后兜底。
  const CANVAS_FRAME_EXPR = `(() => {
    let best = null, bestArea = 0;
    for (const app of document.querySelectorAll('[role="application"]')) {
      let el = app;
      for (let i = 0; el && i < 8; i++) {
        const rr = el.getBoundingClientRect();
        if (rr.width > 5 && rr.height > 5) {
          const area = rr.width * rr.height;
          if (area > bestArea) { bestArea = area; best = rr; }
          break;
        }
        el = el.parentElement;
      }
    }
    if (best) return best;
    const legacy = document.querySelector('.jXCxjw');
    return legacy ? legacy.getBoundingClientRect() : null;
  })()`;

  // 画布容器是否存在（新旧锚点都缺失才说明 Canva 改了结构）
  function hasDesignOverlay() {
    return evaluate(`!!${CANVAS_FRAME_EXPR}`);
  }

  // 各流程开头调用：缺失则显式告警，避免静默返回空导致误判为"无文字"
  async function warnIfNoOverlay() {
    if (!(await hasDesignOverlay())) {
      log("⚠ 未找到画布容器(Canvas content / .jXCxjw)，Canva 可能已更新页面结构，本次可能无法识别任何文字。");
    }
  }

  // 取第 i 页缩略图中心坐标（先滚动到可见）
  // 注意：aria-label="Page N" 可能同时命中无障碍镜像树的折叠节点（rect 恒为 0），必须限定 role=button 取真实缩略图。
  // 中文界面实测格式为 "第N页"（无空格，非简单替换），需双语候选。
  function getPageThumbRect(i) {
    return evaluate(`(() => {
      const el = [...document.querySelectorAll('[aria-label="Page ${i}"], [aria-label="第${i}页"]')].find(e => e.getAttribute('role') === 'button');
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2), w: r.width };
    })()`);
  }

  // 枚举当前页画布区域内的文字元素（中心坐标 + 显示字号 px）
  function enumerateTexts() {
    return evaluate(`(() => {
      const frame = ${CANVAS_FRAME_EXPR};
      if (!frame) return [];
      // 阈值用 10px 而非 0：字幕的非当前时刻副本会塌缩成近似 0 宽/高（如 w=0.35），
      // 单纯 width>0 挡不住这类假阳性，必须要求有意义的可视尺寸
      const inDesign = (r) => r.width>10 && r.height>10 &&
        r.left>=frame.left-2 && r.right<=frame.right+2 &&
        r.top>=frame.top-2 && r.bottom<=frame.bottom+2;
      const seen = new Set(), items = [];
      for (const p of document.querySelectorAll('p')) {
        const txt = (p.textContent||'').trim();
        if (!txt) continue;
        const r = p.getBoundingClientRect();
        if (!inDesign(r)) continue;
        const fpx = parseFloat(getComputedStyle(p).fontSize);
        if (!(fpx >= 20)) continue;
        const key = Math.round(r.x)+','+Math.round(r.y);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({
          text: txt.slice(0, 24),
          fontPx: fpx,
          cx: Math.round(r.x + r.width/2),
          cy: Math.round(r.y + r.height/2),
        });
      }
      return items;
    })()`);
  }

  // 读当前选中元素的字号框状态
  // 中文界面实测 aria-label 为 "字体大小"
  function readFontField() {
    return evaluate(`(() => {
      const fi = document.querySelector('input[aria-label="Font size"], input[aria-label="字体大小"]');
      if (!fi) return { present: false };
      const r = fi.getBoundingClientRect();
      return {
        present: true,
        readonly: fi.hasAttribute('readonly'),
        value: parseFloat(fi.value),
        cx: Math.round(r.x + r.width/2),
        cy: Math.round(r.y + r.height/2),
      };
    })()`);
  }

  // 选中字号框里的全部文字（选择操作不受信任限制，仅值变更需要可信事件）
  function selectFontFieldAll() {
    return evaluate(`(() => {
      const fi = document.querySelector('input[aria-label="Font size"], input[aria-label="字体大小"]');
      if (fi) { fi.focus(); fi.select(); return true; }
      return false;
    })()`);
  }

  async function setSizeForSelected(size) {
    const f = await readFontField();
    if (!f || !f.present || isNaN(f.value)) return { applied: false, reason: "no-field" };
    // 聚焦字号框
    await clickAt(f.cx, f.cy);
    await sleep(120);
    await selectFontFieldAll();
    await sleep(60);
    await typeText(String(size));
    await sleep(60);
    await pressEnter();
    await sleep(250);
    const after = await readFontField();
    return { applied: after && Math.round(after.value) === size, after: after && after.value };
  }

  // 双击进入文字编辑 → 全选 → 替换文本 → 退出编辑
  async function replaceTextInCanva(cx, cy, newText) {
    await doubleClickAt(cx, cy);
    await sleep(300);
    await pressSelectAll();
    await sleep(100);
    await typeText(newText);
    await sleep(100);
    await pressEscape();
    await sleep(200);
  }

  // —— 高亮动画相关 ——

  // label 支持传入候选数组（中英双语），依次尝试直到命中
  function findByAria(labelOrList) {
    const labels = Array.isArray(labelOrList) ? labelOrList : [labelOrList];
    const selector = labels.map(l => `button[aria-label=${JSON.stringify(l)}]`).join(', ');
    return evaluate(`(() => {
      const b = document.querySelector(${JSON.stringify(selector)});
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
  }

  // Captions 区的 Highlight 开关（存在即说明选中的是字幕）
  // 中文界面实测该动效预设名为 "强调"（Canva 翻译选择，非字面直译，非常规词典可猜）
  function readHighlightSwitch() {
    return evaluate(`(() => {
      const b = [...document.querySelectorAll('button[role="switch"]')]
        .find(x => ['Highlight','强调'].includes((x.textContent||'').trim()));
      if (!b) return { present: false };
      const r = b.getBoundingClientRect();
      return {
        present: true,
        pressed: b.getAttribute('aria-checked') === 'true',
        cx: Math.round(r.x + r.width/2),
        cy: Math.round(r.y + r.height/2),
      };
    })()`);
  }

  // 中文界面实测 aria-label 为 "十六进制颜色代码"
  function focusHexInput() {
    return evaluate(`(() => {
      const fi = document.querySelector('input[aria-label="Hex color code"], input[aria-label="十六进制颜色代码"]');
      if (!fi) return false;
      fi.focus(); fi.select();
      return true;
    })()`);
  }

  function readHexInput() {
    return evaluate(`(() => {
      const fi = document.querySelector('input[aria-label="Hex color code"], input[aria-label="十六进制颜色代码"]');
      return fi ? fi.value : null;
    })()`);
  }

  // 给当前选中的字幕套 Highlight 动画并设颜色（hex 不含 #）
  async function setAnimationColorForSelected(hexNoHash) {
    // 若动画面板未显示 Highlight，则点 Animate 打开
    let hl = await readHighlightSwitch();
    if (!hl.present) {
      const ab = await findByAria(["Animate", "动效"]);
      if (!ab) return { applied: false, reason: "no-animate-btn" };
      await clickAt(ab.cx, ab.cy);
      await sleep(700);
      hl = await readHighlightSwitch();
    }
    if (!hl.present) return { applied: false, reason: "not-caption" };

    // 只在未选中时才点 Highlight（已选中再点会取消）
    if (!hl.pressed) {
      await clickAt(hl.cx, hl.cy);
      await sleep(500);
    }

    // 打开取色 → 新增自定义色 → 填 hex
    const cb = await findByAria(["Color", "颜色"]);
    if (!cb) return { applied: false, reason: "no-color-btn" };
    await clickAt(cb.cx, cb.cy);
    await sleep(600);

    const add = await findByAria(["Add a new color", "添加新颜色"]);
    if (!add) return { applied: false, reason: "no-add-color" };
    await clickAt(add.cx, add.cy);
    await sleep(600);

    const ok = await focusHexInput();
    if (!ok) return { applied: false, reason: "no-hex-input" };
    await sleep(80);
    await typeText(hexNoHash);
    await sleep(80);
    await pressEnter();
    await sleep(400);

    const after = await readHexInput();
    return { applied: true, after };
  }

  // 对当前渲染在画布上的这一页执行「枚举文字→逐个上高亮色」，返回本页统计
  async function adjustCurrentPageAnimation(pageLabel, hexNoHash) {
    let changed = 0, skipped = 0, errors = 0;
    const texts = await enumerateTexts();
    log(`${pageLabel}：发现 ${texts.length} 个文字元素。`);

    for (const t of texts) {
      await clickAt(t.cx, t.cy);
      await sleep(300);
      const res = await setAnimationColorForSelected(hexNoHash);
      if (res.applied) {
        log(`  ✓ 「${t.text}」高亮色 → #${hexNoHash}`);
        changed++;
      } else if (res.reason === "not-caption") {
        log(`  · 跳过「${t.text}」（非字幕）`);
        skipped++;
      } else {
        log(`  ✗ 「${t.text}」失败（${res.reason}）`);
        errors++;
      }
    }
    return { changed, skipped, errors };
  }

  async function runAnimate(color, allPages) {
    const hexNoHash = String(color).replace(/^#/, "").toUpperCase();
    let changed = 0, skipped = 0, errors = 0;
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");
      await warnIfNoOverlay();

      const info = await readPageInfo();

      if (allPages && !info) {
        log(`高亮动画颜色 #${hexNoHash}。`);
        const ok = await iterateVideoPagesViaCaptions(async (label) => {
          const r = await adjustCurrentPageAnimation(label, hexNoHash);
          changed += r.changed; skipped += r.skipped; errors += r.errors;
        });
        if (!ok) {
          send("done", { ok: false });
          return;
        }
      } else {
        const total = info ? info.total : 1;
        const startPage = allPages ? 1 : (info ? info.current : 1);
        const endPage = allPages ? total : startPage;
        log(`${allPages ? "所有" : "仅当前"}页（${startPage}–${endPage} / ${total}），高亮动画颜色 #${hexNoHash}。`);

        for (let i = startPage; i <= endPage; i++) {
          if (state.cancelled) break;
          send("status", { text: `第 ${i} / ${total} 页…` });

          if (allPages) {
            if (!(await navigateToPage(i))) {
              log(`  ✗ 第 ${i} 页：未找到页面缩略图，无法翻页（已尝试切换 Pages 视图），跳过`);
              errors++;
              continue;
            }
          }
          await sleep(400);

          const r = await adjustCurrentPageAnimation(`第 ${i} 页`, hexNoHash);
          changed += r.changed; skipped += r.skipped; errors += r.errors;
          await pressEscape();
          await sleep(150);
        }
      }

      log(`\n完成：上色 ${changed} 处，跳过 ${skipped} 处，失败 ${errors} 处。`);
      send("done", { ok: errors === 0 });
    } catch (e) {
      log("运行出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  // 校准「渲染 px → 真实字号」的比例：在本页未选中任何元素时逐个尝试点击
  // enumerateTexts() 的候选（同一页面缩放下该比例对所有元素恒定，实测多次
  // 均为常数），读到第一个非混合字号的真实值即可换算 scale，随后无需逐个
  // 点击就能判断每个元素的真实字号，从根本上避免"点击→读值"被悬浮工具条
  // 遮挡或读到上一个元素残留值而误判的问题。
  async function calibrateScale(texts) {
    for (const t of texts) {
      await clickAt(t.cx, t.cy);
      await sleep(300);
      const f = await readFontField();
      await pressEscape();
      await sleep(150);
      if (f && f.present && !isNaN(f.value) && f.value > 0) {
        return t.fontPx / f.value;
      }
    }
    return null;
  }

  // 点击目标并用「校准换算出的真实字号」核对是否选中了预期元素：一致才继续。
  // 悬浮工具条只会挡在目标框上方，若核对失败，向下偏移坐标重试一次，仍失败则
  // 明确跳过（不再像旧逻辑那样盲信点击后读到的值）。
  async function clickAndVerify(t, expectedReal, retried) {
    await clickAt(t.cx, t.cy);
    await sleep(300);
    const f = await readFontField();
    if (f && f.present && !isNaN(f.value) && Math.abs(f.value - expectedReal) <= 1) {
      return { ok: true, f };
    }
    // 字号框存在但读不到数值 = 该选区内部混有多种字号（Canva 显示"混合值"占位），
    // 不是点偏了，重试也没用，直接判定为需要人工处理。
    if (f && f.present && isNaN(f.value)) {
      return { ok: false, mixed: true, reason: "该文字框内混有多种字号（选中后字号框显示为空）" };
    }
    if (!retried) {
      await pressEscape();
      await sleep(150);
      return clickAndVerify({ ...t, cy: t.cy + 10 }, expectedReal, true);
    }
    return {
      ok: false,
      reason: f && f.present
        ? `读到 ${f.value}，与预期 ${expectedReal} 不符（可能选中了其他元素）`
        : "字号框未出现（可能未选中文字）",
    };
  }

  // 对当前渲染在画布上的这一页执行「枚举文字→逐个改字号」，返回本页统计
  // split（可选）：{ boundary, titleSize, bodySize }——按真实字号分档：
  // >= boundary 视为标题改 titleSize，否则视为正文改 bodySize。
  // 真实字号来自 calibrateScale 换算，而非逐个点击读值（画布缩放会让渲染
  // px 与真实值不一致，且逐个点击易被悬浮工具条遮挡导致误判）。
  async function adjustCurrentPageTexts(pageLabel, size, threshold, split) {
    let changed = 0, skipped = 0, errors = 0;
    const texts = await enumerateTexts();
    log(`${pageLabel}：发现 ${texts.length} 个文字元素。`);
    if (texts.length === 0) return { changed, skipped, errors };

    const scale = await calibrateScale(texts);
    if (!scale) {
      log(`  ⚠ 校准失败（未能读到任何元素的真实字号），本页跳过。`);
      return { changed, skipped: texts.length, errors };
    }

    for (const t of texts) {
      const real = Math.round(t.fontPx / scale);
      if (real < threshold) {
        log(`  · 跳过「${t.text}」（换算字号 ${real} < 阈值 ${threshold}）`);
        skipped++;
        continue;
      }
      const target = split
        ? (real >= split.boundary ? split.titleSize : split.bodySize)
        : size;
      if (real === target) {
        log(`  · 跳过「${t.text}」（已是目标字号 ${target}）`);
        skipped++;
        continue;
      }

      const sel = await clickAndVerify(t, real);
      if (!sel.ok) {
        if (sel.mixed) {
          log(`  ⚠ 「${t.text}」混有多种字号，工具无法自动分档，请手动到 Canva 里检查并调整`);
          skipped++;
        } else {
          log(`  ✗ 「${t.text}」点击验证失败（${sel.reason}），已跳过`);
          errors++;
        }
        continue;
      }

      const res = await setSizeForSelected(target);
      if (res.applied) {
        log(`  ✓ 「${t.text}」 ${real} → ${target}${split ? (real >= split.boundary ? "（标题）" : "（正文）") : ""}`);
        changed++;
      } else {
        log(`  ✗ 「${t.text}」设置失败（结果 ${res.after}）`);
        errors++;
      }
    }
    return { changed, skipped, errors };
  }

  // 本页字幕段逐条经转录面板选中并设字号。
  // 画布上同页多段字幕只有播放头当前时刻那条正常渲染，其余塌缩成 ~0 宽被
  // enumerateTexts 的 10px 过滤挡掉（该过滤不能去掉，防假点击）——所以画布枚举
  // 每页只能改到 1 段（用户反馈"每页只改第一条"的根因）。唯一可靠入口是
  // Captions → Transcript 面板：点某行会定位播放头并选中该段（校对流程同款路径）。
  // 时间轴分段条：每段字幕在画布下方有一个逐段小样，其 CSS font-size 与画布同基准，
  // 是各段真实字号的可靠观测点（画布内塌缩副本的样式不可信，见 arch #21）
  function readTimelineStripSizes() {
    return evaluate(`(() => {
      const frame = ${CANVAS_FRAME_EXPR};
      if (!frame) return [];
      const out = [];
      for (const p of document.querySelectorAll('p')) {
        const t = (p.textContent || '').trim();
        if (!t) continue;
        const r = p.getBoundingClientRect();
        if (r.top <= frame.bottom) continue;
        const fpx = parseFloat(getComputedStyle(p).fontSize);
        if (!(fpx >= 20)) continue;
        out.push({ key: t.toLowerCase().replace(/[^a-z0-9]/g, ''), px: fpx });
      }
      return out;
    })()`);
  }

  async function adjustPageCaptionSegs(page, lines, size, threshold, split) {
    let changed = 0, skipped = 0, errors = 0;
    log(`第 ${page} 页：转录面板字幕 ${lines.length} 段。`);

    // 同组联动快速跳过：同一页字幕可能被合并成组（改一段全组生效），也可能一页多个组。
    // 不猜组结构——改完一段后重读分段条，估算字号已到目标的段直接跳过；
    // 估算失败/歧义/不等于目标一律走完整路径，误判方向只会多查不会漏改。
    let pxPerUnit = null; // 渲染px / 字号值，来自完整路径读到的精确值对
    let strip = null;
    const stripValue = (text) => {
      if (!pxPerUnit || !strip) return null;
      const want = text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!want) return null;
      const hits = strip.filter((s) => s.key === want || s.key.startsWith(want) || want.startsWith(s.key));
      if (!hits.length) return null;
      if (hits.some((h) => Math.abs(h.px - hits[0].px) > 0.5)) return null; // 跨页同文异号
      return Math.round(hits[0].px / pxPerUnit);
    };

    for (const text of lines) {
      if (state.cancelled) break;
      const label = text.slice(0, 20);

      const est = stripValue(text);
      if (est != null) {
        const estTarget = split ? (est >= split.boundary ? split.titleSize : split.bodySize) : size;
        if (est === estTarget) {
          log(`  · 跳过「${label}」（分段条显示已是 ${est}，同组联动）`);
          skipped++;
          continue;
        }
      }

      if (!(await openCaptionsPanel())) {
        log(`  ✗ 无法打开字幕面板，跳过「${label}」`);
        errors++;
        continue;
      }
      await sleep(250);
      const line = await findTranscriptLine(page, text);
      if (!line) {
        log(`  ✗ 转录面板未找到「${label}」，跳过`);
        errors++;
        continue;
      }
      await clickAt(line.cx, line.cy); // 关闭面板 + 定位播放头 + 选中该段
      await sleep(600);
      let f = await readFontField();
      if (!f || !f.present || isNaN(f.value)) {
        // 转录点击未带出字号框 → 在画布上点渲染出来的该段
        const cap = await findRenderedCaption(text);
        if (cap && cap.ok) {
          await clickAt(cap.cx, cap.cy);
          await sleep(300);
          f = await readFontField();
        }
      }
      if (!f || !f.present || isNaN(f.value)) {
        log(`  ✗ 「${label}」未能选中，跳过`);
        errors++;
      } else if (f.value < threshold) {
        log(`  · 跳过「${label}」（当前 ${f.value} < 阈值 ${threshold}）`);
        skipped++;
      } else {
        // 用本段（真实字号, 分段条px）这对精确值标定换算系数
        const stripNow = await readTimelineStripSizes();
        const meKey = text.toLowerCase().replace(/[^a-z0-9]/g, '');
        const me = stripNow.find((s) => s.key === meKey || s.key.startsWith(meKey) || meKey.startsWith(s.key));
        if (me && f.value > 0) { pxPerUnit = me.px / f.value; strip = stripNow; }

        const target = split
          ? (f.value >= split.boundary ? split.titleSize : split.bodySize)
          : size;
        if (Math.round(f.value) === target) {
          log(`  · 跳过「${label}」（已是目标字号 ${target}）`);
          skipped++;
        } else {
          const res = await setSizeForSelected(target);
          if (res.applied) {
            log(`  ✓ 「${label}」 ${f.value} → ${target}${split ? (f.value >= split.boundary ? "（标题）" : "（正文）") : ""}`);
            changed++;
            strip = await readTimelineStripSizes(); // 改动后重读，供后续段的同组联动判断
          } else {
            log(`  ✗ 「${label}」设置失败（结果 ${res.after}）`);
            errors++;
          }
        }
      }
      await pressEscape();
      await sleep(150);
    }
    return { changed, skipped, errors };
  }

  // 页号未知时（视频设计 readPageInfo 为 null 且仅当前页运行），
  // 用画布上可见的字幕文本反查它属于转录面板的哪一页
  async function findCurrentCaptionPage(captionsByPage) {
    const texts = await enumerateTexts();
    const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const t of texts) {
      const tn = norm(t.text); // 枚举文本截断到 24 字符 → 前缀匹配
      if (!tn) continue;
      for (const [pg, lines] of captionsByPage) {
        if (lines.some((l) => norm(l).startsWith(tn))) return pg;
      }
    }
    return null;
  }

  async function run(size, threshold, allPages, split) {
    let changed = 0, skipped = 0, errors = 0;
    const goalDesc = split
      ? `标题(≥${split.boundary}) → ${split.titleSize}，正文 → ${split.bodySize}`
      : `目标字号 ${size}`;
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");
      await warnIfNoOverlay();

      const info = await readPageInfo();

      // 有原生字幕的设计：先读一次转录面板，拿到每页的全部字幕段。
      // 读不到（经典无字幕设计）则 captionsByPage 为 null，后续流程与旧版完全一致。
      let captionsByPage = null;
      if (await openCaptionsPanel()) {
        const transcript = await readCaptionsTranscript();
        if (transcript.length) {
          captionsByPage = new Map();
          for (const t of transcript) {
            if (!captionsByPage.has(t.page)) captionsByPage.set(t.page, []);
            captionsByPage.get(t.page).push(t.text);
          }
        }
      }

      if (allPages && !info) {
        if (!captionsByPage) {
          log("未能打开 Captions 转录面板，无法枚举全部页（当前设计可能没有 Canva 原生字幕）。");
          send("done", { ok: false });
          return;
        }
        const pages = [...captionsByPage.keys()].sort((a, b) => a - b);
        log(`所有页（共 ${pages.length} 页，经字幕面板确认），${goalDesc}，阈值 ≥ ${threshold}。`);
        for (const p of pages) {
          if (state.cancelled) break;
          send("status", { text: `第 ${p} / ${pages[pages.length - 1]} 页…` });
          const s = await adjustPageCaptionSegs(p, captionsByPage.get(p), size, threshold, split);
          changed += s.changed; skipped += s.skipped; errors += s.errors;
          // 逐段点完后播放头已停在本页 → 再按画布枚举处理本页静态文字（标题/正文等）
          const r = await adjustCurrentPageTexts(`第 ${p} 页（画布静态文字）`, size, threshold, split);
          changed += r.changed; skipped += r.skipped; errors += r.errors;
          await pressEscape();
          await sleep(150);
        }
      } else {
        // 经典设计：有"当前/总页"文字，缩略图点击可正常翻页
        const total = info ? info.total : 1;
        const startPage = allPages ? 1 : (info ? info.current : 1);
        const endPage = allPages ? total : startPage;
        log(`${allPages ? "所有" : "仅当前"}页（${startPage}–${endPage} / ${total}），${goalDesc}，阈值 ≥ ${threshold}。`);

        for (let i = startPage; i <= endPage; i++) {
          if (state.cancelled) break;
          send("status", { text: `第 ${i} / ${total} 页…` });

          if (allPages) {
            if (!(await navigateToPage(i))) {
              log(`  ✗ 第 ${i} 页：未找到页面缩略图，无法翻页（已尝试切换 Pages 视图），跳过`);
              errors++;
              continue;
            }
          }
          await sleep(400);

          // 本页有字幕段则先经转录面板逐段补齐（Duration 视图等 info 可读的视频设计）
          if (captionsByPage) {
            let capPage = info && captionsByPage.has(i) ? i : null;
            if (capPage == null) capPage = await findCurrentCaptionPage(captionsByPage);
            if (capPage != null && captionsByPage.has(capPage)) {
              const s = await adjustPageCaptionSegs(capPage, captionsByPage.get(capPage), size, threshold, split);
              changed += s.changed; skipped += s.skipped; errors += s.errors;
            }
          }

          const r = await adjustCurrentPageTexts(`第 ${i} 页${captionsByPage ? "（画布静态文字）" : ""}`, size, threshold, split);
          changed += r.changed; skipped += r.skipped; errors += r.errors;
          await pressEscape();
          await sleep(150);
        }
      }

      log(`\n完成：修改 ${changed} 处，跳过 ${skipped} 处，失败 ${errors} 处。`);
      send("done", { ok: errors === 0 });
    } catch (e) {
      log("运行出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  // —— 字幕校对相关 ——

  // Canva 原生字幕的唯一可靠数据源是「Captions → Transcript」面板：
  // 一次挂载全部页、按 "Page N" 分组、每条字幕是左面板的叶子 <div>。
  // 画布上同一页多条时间字幕堆叠在同一坐标、只有当前时刻那条可点，
  // 所以读取/应用都走这个面板，不再用画布坐标枚举（旧法每页只剩 1 条）。

  function isCaptionsPanelOpen() {
    return evaluate(`(() => {
      for (const d of document.querySelectorAll('div')) {
        const t = d.textContent || '';
        if (t.includes('Delete all captions') && /Page \\d+/.test(t)) return true;
      }
      return false;
    })()`);
  }

  // 顶部工具栏(顶端)里文本精确匹配的按钮中心坐标
  function findToolbarButton(label) {
    return evaluate(`(() => {
      const cands = [...document.querySelectorAll('button,div[role="button"],span')]
        .filter(x => (x.textContent || '').trim() === ${JSON.stringify(label)});
      const hit = cands.map(x => ({ x, r: x.getBoundingClientRect() }))
        .filter(o => o.r.top < 120 && o.r.width > 0)
        .sort((a, b) => a.r.x - b.r.x)[0];
      if (!hit) return null;
      return { cx: Math.round(hit.r.x + hit.r.width / 2), cy: Math.round(hit.r.y + hit.r.height / 2) };
    })()`);
  }

  // 选中当前页视频片段并打开 Captions → Transcript 面板
  // 字幕框在画布上的垂直位置因设计而异（2026-07 实测某设计字幕在 60% 高度而非
  // 常见的顶部区域），固定点一个高度分数选不中字幕元素、工具栏就不会出现 Captions
  // 按钮。改为按多个高度分数依次尝试，命中第一个能找到 Captions 按钮的位置。
  async function openCaptionsPanel() {
    if (await isCaptionsPanelOpen()) return true;
    const frame = await evaluate(`(() => { const r = ${CANVAS_FRAME_EXPR}; return r ? {left:r.left, top:r.top, width:r.width, height:r.height} : null; })()`);
    if (!frame) return false;
    for (const frac of [0.4, 0.5, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const cx = Math.round(frame.left + frame.width / 2);
      const cy = Math.round(frame.top + frame.height * frac);
      await clickAt(cx, cy);
      await sleep(350);
      const cap = await findToolbarButton("Captions");
      if (cap) {
        await clickAt(cap.cx, cap.cy);
        await sleep(600);
        if (await isCaptionsPanelOpen()) return true;
      }
      await pressEscape();
      await sleep(150);
    }
    return false;
  }

  // 读取转录面板里全部字幕，按页返回 [{page, text}]（文档顺序）
  function readCaptionsTranscript() {
    return evaluate(`(() => {
      let root = null, best = Infinity;
      for (const d of document.querySelectorAll('div')) {
        const t = d.textContent || '';
        if (t.includes('Delete all captions') && /Page \\d+/.test(t)) {
          const n = d.querySelectorAll('*').length;
          if (n < best) { best = n; root = d; }
        }
      }
      if (!root) return [];
      const rr = root.getBoundingClientRect();
      const skip = new Set(['Transcript', 'Styles', 'Delete all captions', 'Captions']);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      const out = []; let cur = null; const seen = new Set();
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const t = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        const m = /^Page (\\d+)$/.exec(t);
        if (m && el.childElementCount <= 1) { cur = parseInt(m[1], 10); continue; }
        if (el.childElementCount === 0 && t && !skip.has(t) && !/^Page \\d+$/.test(t)
            && r.width > 40 && r.left >= rr.left - 2 && r.right <= rr.right + 2) {
          const key = cur + '|' + t;
          if (seen.has(key)) continue; seen.add(key);
          if (cur != null) out.push({ page: cur, text: t });
        }
      }
      return out;
    })()`);
  }

  // 在转录面板里按「页号+文本」定位某条字幕，返回其中心坐标（点它会让 Canva 自动定位+选中该字幕）
  function findTranscriptLine(page, text) {
    return evaluate(`(() => {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      let root = null, best = Infinity;
      for (const d of document.querySelectorAll('div')) {
        const t = d.textContent || '';
        if (t.includes('Delete all captions') && /Page \\d+/.test(t)) {
          const n = d.querySelectorAll('*').length;
          if (n < best) { best = n; root = d; }
        }
      }
      if (!root) return null;
      const rr = root.getBoundingClientRect();
      const want = ${JSON.stringify(text)}.trim(), wantN = norm(want), wantPage = ${Number(page)};
      const skip = new Set(['Transcript', 'Styles', 'Delete all captions', 'Captions']);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let cur = null; let exactEl = null, fuzzyEl = null;
      while (walker.nextNode()) {
        const el = walker.currentNode;
        const t = (el.textContent || '').trim();
        const r = el.getBoundingClientRect();
        const m = /^Page (\\d+)$/.exec(t);
        if (m && el.childElementCount <= 1) { cur = parseInt(m[1], 10); continue; }
        if (el.childElementCount === 0 && t && !skip.has(t) && !/^Page \\d+$/.test(t)
            && cur === wantPage && r.width > 40 && r.left >= rr.left - 2 && r.right <= rr.right + 2) {
          if (t === want) { exactEl = el; break; }
          if (!fuzzyEl && norm(t) === wantN) fuzzyEl = el;
        }
      }
      const target = exactEl || fuzzyEl;
      if (!target) return null;
      // 转录面板是可滚动列表（29 页设计实测 scrollHeight 12564 vs 可视 875px)，
      // 未滚入视口的行 getBoundingClientRect 仍返回非零矩形但坐标落在面板可视区域外，
      // 点它会打在面板下方别的元素上（表现为"选中"了错误内容→后续读字号框返回 no-field，
      // 只有转录面板前 1-2 屏内的页能被正确选中，翻页到后面的页悄悄失效）。
      // 必须先把命中的行滚入视口，再用滚动后的新坐标点击。
      target.scrollIntoView({ block: 'center' });
      const r2 = target.getBoundingClientRect();
      return { cx: Math.round(r2.x + r2.width / 2), cy: Math.round(r2.y + r2.height / 2) };
    })()`);
  }

  // 定位当前渲染在画布上的字幕（与目标文本模糊匹配，兼容换行拼接的空格差异）
  function findRenderedCaption(target) {
    return evaluate(`(() => {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const want = norm(${JSON.stringify(target)});
      const frame = ${CANVAS_FRAME_EXPR};
      if (!frame) return null;
      const cands = [...document.querySelectorAll('p')].filter(p => {
        const r = p.getBoundingClientRect();
        if (!(r.width > 10 && r.height > 10 && parseFloat(getComputedStyle(p).fontSize) >= 40)) return false;
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        return cx >= frame.left && cx <= frame.right && cy >= frame.top && cy <= frame.bottom;
      });
      const hit = cands.find(p => norm(p.textContent) === want)
               || cands.find(p => { const n = norm(p.textContent); return n && (n.includes(want) || want.includes(n)); });
      if (!hit) return { ok: false, seen: cands.map(p => (p.textContent || '').trim().slice(0, 30)) };
      const r = hit.getBoundingClientRect();
      return { ok: true, cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
    })()`);
  }

  async function callProofreadAPI(cfg, textsWithPage, rules) {
    const lines = textsWithPage.map((t) => `[Page ${t.page}] ${t.text}`).join("\n");
    const rulesBlock = rules
      ? `\nProofreading rules (apply strictly):\n${rules}\n`
      : "";
    const prompt = `You are a subtitle proofreader that fixes ONLY automatic-captioning artifacts.
The subtitles come from a script whose WORDS are already correct; they were produced by automatic speech captioning, which corrupts ONLY capitalization and punctuation (especially lower-casing names and divine words like God, Jesus, the Lord, and divine pronouns He/Him/His). Fix ONLY capitalization and punctuation. NEVER add, remove, substitute, reorder, or re-spell any word.${rulesBlock}
Each subtitle is one card of a video; a sentence is intentionally split across multiple cards. Do NOT check or judge sentence completeness: never flag, complete, merge, or re-split a subtitle just because it is a sentence fragment, ends mid-clause, lacks ending punctuation, or starts mid-sentence. Treat each subtitle's text boundaries as fixed.

Editing constraints:
- Change ONLY letter casing and punctuation marks. Between "original" and "corrected", the words and their order must be IDENTICAL — none added, removed, reordered, or re-spelled. If a fix would require changing the letters of a word (anything beyond its case), do NOT make it. Adding/removing punctuation (commas, periods, apostrophes for possessives/contractions) is allowed.
- The "original" field MUST be the subtitle's text copied VERBATIM, character for character, so it can be located on the canvas. Never clean up or normalize the "original".
- Enforce consistency across the ENTIRE set: the same name or term must be capitalized identically across all cards.

Check the following subtitles and apply ALL of the rules above. Only include subtitles that actually need correction — if a subtitle already conforms to every rule, do NOT include it.

Return ONLY a raw JSON array (no markdown fences, no extra text):
[{"page":1,"original":"exact original text","corrected":"corrected text","reason":"brief explanation"}]

If nothing needs correction, return exactly: []

Subtitles to check:
${lines}`;

    // 后端由 popup 显式指定；model 留空时回退到各后端默认值
    const key = (cfg.apiKey || "").trim();
    const provider = cfg.provider || (key ? "openrouter" : "local");

    let text;
    if (provider === "gemini") {
      // Gemini AI Studio 原生格式（与 OpenAI 不同）
      const model = cfg.model || GEMINI_MODEL;
      const url = GEMINI_URL_BASE + model + ":generateContent?key=" + encodeURIComponent(key);
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 16384,
            temperature: 0,                       // 校对要可复现，关闭随机性
            responseMimeType: "application/json",  // 强制返回合法 JSON，免去刮取/截断风险
          },
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`Gemini ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      text = parts.map((p) => p.text || "").join("") || "[]";
    } else {
      // OpenAI 兼容格式：OpenRouter（云端）或本机代理
      const url = provider === "openrouter" ? OPENROUTER_URL : LOCAL_PROXY_URL;
      const model = cfg.model || (provider === "openrouter" ? OPENROUTER_MODEL : LOCAL_PROXY_MODEL);
      const headers = { "Content-Type": "application/json" };
      if (provider === "openrouter") headers["Authorization"] = "Bearer " + key;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          temperature: 0, // 校对要可复现，关闭随机性
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new Error(`API ${resp.status}: ${body.slice(0, 200)}`);
      }
      const data = await resp.json();
      text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "[]";
    }
    // 容忍 LLM 返回 markdown 代码块、尾逗号、额外文字
    let jsonStr = text
      .replace(/^[\s\S]*?(?=\[)/m, "")          // 丢弃 [ 之前的任何文字
      .replace(/][\s\S]*$/, "]")                 // 丢弃 ] 之后的任何文字
      .replace(/```/g, "")                       // 清除残留 fence
      .replace(/,\s*([}\]])/g, "$1")             // 去尾逗号
      .trim();
    if (!jsonStr.startsWith("[")) jsonStr = "[]"; // 安全兜底
    try {
      return JSON.parse(jsonStr);
    } catch (_) {
      // 响应可能被截断——尝试截断到最后一个完整对象后补 ]
      const lastBrace = jsonStr.lastIndexOf("}");
      if (lastBrace > 0) {
        const repaired = jsonStr.slice(0, lastBrace + 1).replace(/,\s*$/, "") + "]";
        try {
          const result = JSON.parse(repaired);
          log("⚠ AI 响应被截断，已自动修复（部分结果）。");
          return result;
        } catch (_2) { /* 修复也失败，走下面兜底 */ }
      }
      log("⚠ AI 返回的 JSON 无法解析，原始内容：\n" + text.slice(0, 500));
      throw new Error("JSON 解析失败");
    }
  }

  // 视频/Reel 设计的翻页：没有"当前/总页"文字，左下角缩略图点击也不会真正翻页
  // （2026-07 实测：可信事件点击缩略图后画布内容、播放头时间、缩略图选中态均无变化）。
  // 改用字幕校对功能里验证可靠的转录面板导航：点转录面板里某页的一条字幕，
  // Canva 会自动把播放头定位到该页并渲染出来。逐页调用 perPage(pageLabel, pageNum)。
  // run/runAnimate/runSetPosition 的 allPages 分支在 readPageInfo() 为空时都走这条路径。
  async function iterateVideoPagesViaCaptions(perPage) {
    if (!(await openCaptionsPanel())) {
      log("未能打开 Captions 转录面板，无法枚举全部页（当前设计可能没有 Canva 原生字幕）。");
      return false;
    }
    const transcript = await readCaptionsTranscript();
    const firstTextByPage = new Map();
    for (const t of transcript) if (!firstTextByPage.has(t.page)) firstTextByPage.set(t.page, t.text);
    const pages = [...firstTextByPage.keys()].sort((a, b) => a - b);
    if (pages.length === 0) return false;
    log(`所有页（共 ${pages.length} 页，经字幕面板确认）。`);

    for (const p of pages) {
      if (state.cancelled) break;
      send("status", { text: `第 ${p} / ${pages[pages.length - 1]} 页…` });

      if (!(await openCaptionsPanel())) {
        log(`  ✗ 第 ${p} 页：无法打开字幕面板，跳过`);
        continue;
      }
      const line = await findTranscriptLine(p, firstTextByPage.get(p));
      if (!line) {
        log(`  ✗ 第 ${p} 页：转录面板里未找到该页字幕，跳过`);
        continue;
      }
      await clickAt(line.cx, line.cy); // 关闭面板 + 定位播放头 + 渲染该页
      await sleep(500);

      await perPage(`第 ${p} 页`, p);
      await pressEscape();
      await sleep(150);
    }
    return true;
  }

  // 翻到指定页（run/runAnimate/runSetPosition 的 allPages 缩略图分支共用）。
  // Duration 时间轴视图下 readPageInfo() 仍返回 "N/M"（会被误判成经典设计、走缩略图分支），
  // 但此视图没有页面缩略图 [aria-label="Page i"] → 旧代码 if(thumb) 静默跳过 → 每页都在当前
  // 那一页上操作 → 只有 1 页被应用。这里缩略图缺失时先点底部 "Pages" 切到缩略图条视图再翻页；
  // 仍找不到才返回 false（改为显式失败，不再静默）。见 arch_decisions #14。
  async function navigateToPage(i) {
    let thumb = await getPageThumbRect(i);
    if (!thumb) {
      const toggle = await findPagesViewToggle();
      if (toggle) {
        await clickAt(toggle.cx, toggle.cy);
        await sleep(600);
        thumb = await getPageThumbRect(i);
      }
    }
    if (!thumb) return false;
    await clickAt(thumb.cx, thumb.cy);
    for (let t = 0; t < 20; t++) {
      await sleep(150);
      const pi = await readPageInfo();
      if (pi && pi.current === i) break;
    }
    await sleep(400);
    return true;
  }

  async function runProofread(cfg, allPages, rules) {
    let allTexts = [];
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");
      await warnIfNoOverlay();

      const info = await readPageInfo();
      const curPage = info ? info.current : 1;

      send("status", { text: "正在打开字幕面板…" });
      const opened = await openCaptionsPanel();
      if (!opened) {
        log("未能打开 Captions 转录面板（当前页可能没有 Canva 原生字幕）。");
        send("proofread-result", { corrections: [] });
        return;
      }
      await sleep(300);

      let transcript = await readCaptionsTranscript();
      if (!allPages) transcript = transcript.filter((t) => t.page === curPage);
      allTexts = transcript.map((t) => ({ page: t.page, text: t.text }));

      const pages = [...new Set(allTexts.map((t) => t.page))].length;
      log(`从字幕面板读取：${allPages ? "全部" : "仅第 " + curPage + " "}页 —— ${pages} 页 / ${allTexts.length} 条字幕`);
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }

    if (allTexts.length === 0) {
      log("未找到任何字幕文本。");
      send("proofread-result", { corrections: [] });
      return;
    }

    log(`共 ${allTexts.length} 条字幕，正在调用 AI 校对…`);
    send("status", { text: "正在调用 AI 校对…" });

    try {
      const corrections = await callProofreadAPI(cfg, allTexts, rules);
      log(`API 返回 ${corrections.length} 条修正建议。`);
      send("proofread-result", { corrections });
    } catch (e) {
      log("API 调用失败：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    }
  }

  // 应用修正：逐条「在转录面板点中该字幕(自动定位+渲染) → 画布上双击替换」。
  // 字幕是时间字幕、画布坐标点不中，必须靠转录面板点击来选中正确的那条。
  async function runApplyCorrections(corrections, allPages) {
    let applied = 0, failed = 0;
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");
      await warnIfNoOverlay();

      const sorted = [...corrections].sort((a, b) => (a.page || 0) - (b.page || 0));
      const total = sorted.length;
      let idx = 0;

      for (const c of sorted) {
        if (state.cancelled) break;
        idx++;
        send("status", { text: `应用修正 ${idx} / ${total}（第 ${c.page} 页）…` });

        // 1) 打开字幕面板并点中该条 —— 点击会让 Canva 自动定位播放头+选中该字幕
        if (!(await openCaptionsPanel())) {
          log(`  ✗ 无法打开字幕面板，跳过「${c.original.slice(0, 24)}」`);
          failed++;
          continue;
        }
        await sleep(250);
        const line = await findTranscriptLine(c.page, c.original);
        if (!line) {
          log(`  ✗ 第${c.page}页转录里未找到「${c.original.slice(0, 24)}」，跳过`);
          failed++;
          continue;
        }
        await clickAt(line.cx, line.cy);   // 关闭面板 + 选中并渲染该字幕
        await sleep(600);

        // 2) 在画布上定位渲染出来的该字幕（模糊匹配，兼容换行拼接的空格差异）
        const cap = await findRenderedCaption(c.original);
        if (!cap || !cap.ok) {
          log(`  ✗ 画布上未匹配到「${c.original.slice(0, 24)}」(渲染:${cap && cap.seen ? cap.seen.join(" | ") : "无"})，跳过`);
          failed++;
          await pressEscape();
          await sleep(150);
          continue;
        }

        // 3) 双击进编辑 → 全选 → 替换 → 退出
        await replaceTextInCanva(cap.cx, cap.cy, c.corrected);
        log(`  ✓ 第${c.page}页「${c.original.slice(0, 20)}」→「${c.corrected.slice(0, 20)}」`);
        applied++;
        await pressEscape();
        await sleep(150);
      }

      log(`\n完成：修正 ${applied} 处，失败 ${failed} 处。`);
      send("done", { ok: failed === 0 });
    } catch (e) {
      log("应用修正出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  // —— 批量添加空白页 ——

  async function runAddPages(count) {
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");

      const info = await readPageInfoRobust();
      const before = info ? info.total : 0;
      log(`当前 ${before} 页，准备添加 ${count} 个空白页。`);

      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        send("status", { text: `添加第 ${i + 1} / ${count} 页…` });
        // 找末尾的大号 "Add page" 按钮（最后一个），滚动到可见后点击
        // 中文界面实测 aria-label 为 "添加页面"
        const btn = await evaluate(`(() => {
          const all = [...document.querySelectorAll('button[aria-label="Add page"], button[aria-label="添加页面"]')];
          const b = all[all.length - 1];
          if (!b) return null;
          b.scrollIntoView({ block: 'nearest', inline: 'center' });
          const r = b.getBoundingClientRect();
          return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
        })()`);
        if (!btn) {
          log(`  ✗ 未找到 "Add page" 按钮`);
          send("done", { ok: false });
          return;
        }
        await clickAt(btn.cx, btn.cy);
        await sleep(800);
      }

      const after = await readPageInfoRobust();
      const total = after ? after.total : before + count;
      log(`完成：${before} → ${total} 页（新增 ${total - before} 页）。`);
      send("done", { ok: true });
    } catch (e) {
      log("添加页面出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  // —— 批量上传视频到各页 ——

  // 打开 Uploads 侧边栏（如果还没打开）
  // 中文界面实测 tab 文本为 "上传"；子标签(图片/视频/音频/设计/文件夹)的 textContent
  // 实测是重复拼接的（如 "文件夹文件夹" 而非 "文件夹"，疑似无障碍镜像文本+可见文本被
  // 一起计入），故统一改用 includes() 子串匹配而非精确相等，中英文候选都覆盖。
  async function openUploadsPanel() {
    const already = await evaluate(`(() => {
      const panel = document.querySelector('[role="tabpanel"][aria-label="Uploads"], [role="tabpanel"]');
      // 检查 Uploads tab 是否 selected
      const tab = [...document.querySelectorAll('[role="tab"]')].find(t => { const s = (t.textContent||'').trim(); return s.includes('Uploads') || s.includes('上传'); });
      return tab ? tab.getAttribute('aria-selected') === 'true' : false;
    })()`);
    if (already) return;
    const btn = await evaluate(`(() => {
      const tab = [...document.querySelectorAll('[role="tab"]')].find(t => { const s = (t.textContent||'').trim(); return s.includes('Uploads') || s.includes('上传'); });
      if (!tab) return null;
      const r = tab.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
    if (btn) {
      await clickAt(btn.cx, btn.cy);
      await sleep(800);
    }
  }

  // 切换到 Uploads 面板内的 Folders 子标签
  async function switchToFoldersTab() {
    const btn = await evaluate(`(() => {
      const ft = [...document.querySelectorAll('[role="tab"]')]
        .find(t => { const s = (t.textContent||'').trim(); return s.includes('Folders') || s.includes('文件夹'); });
      if (!ft) return null;
      const r = ft.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
    if (btn) {
      await clickAt(btn.cx, btn.cy);
      await sleep(600);
    }
  }

  // 按名称打开 Folders 列表里的某个文件夹；找不到则返回现有文件夹名
  // 文件夹行是可见的 div[role="group"]（含 "N items"）；需排除包住所有文件夹、
  // 尺寸为 0 的外层容器——取 textContent 最短的那个匹配项（最贴合的单行）
  async function openFolderByName(name) {
    const res = await evaluate(`(() => {
      const groups = [...document.querySelectorAll('div[role="group"]')].filter(g => {
        const r = g.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /\\d+\\s+items?/.test(g.textContent||'');
      });
      const matches = groups.filter(x => (x.textContent||'').includes(${JSON.stringify(name)}));
      if (matches.length === 0) {
        return { found: false, available: groups.map(x => (x.textContent||'').trim().slice(0, 40)) };
      }
      matches.sort((a, b) => (a.textContent||'').length - (b.textContent||'').length);
      const r = matches[0].getBoundingClientRect();
      return { found: true, cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
    if (res && res.found) {
      await clickAt(res.cx, res.cy);
      await sleep(1500);
    }
    return res;
  }

  // 枚举 Uploads Videos 标签下的所有视频项（按显示顺序，通常最新在前）
  // 实测：视频项是含时长标签(如 "25.0s")的 div[draggable="true"]，位于左侧面板
  async function getUploadedVideos() {
    return evaluate(`(() => {
      const vw = innerWidth;
      const isDur = (el) => [...el.querySelectorAll('*')].some(c =>
        c.children.length === 0 && /^\\d+(\\.\\d+)?s$/.test((c.textContent||'').trim()));
      const out = [];
      for (const el of document.querySelectorAll('div[draggable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height > 30 && r.left < vw * 0.4 && isDur(el)) {
          out.push({
            cx: Math.round(r.x + r.width/2),
            cy: Math.round(r.y + r.height/2),
            label: (el.getAttribute('aria-label') || '').slice(0, 60),
          });
        }
      }
      return out;
    })()`);
  }

  // 面板列表是懒加载不是虚拟列表（2026-07 实测 106 项文件夹初始只挂 40 项，
  // 滚到底全部挂载且滚出视口后不卸载）——枚举前滚到底直到瓦片数连续两轮不变。
  // 滚动容器 = 左面板内唯一一个 宽 250~420、高 >300 且内容明显溢出的 div。
  async function scrollPanelToBottom() {
    let last = -1, stable = 0;
    for (let i = 0; i < 20 && stable < 2; i++) {
      const res = await evaluate(`(() => {
        const sc = [...document.querySelectorAll('div')].find(el => {
          const r = el.getBoundingClientRect();
          return r.left < 100 && r.width > 250 && r.width < 420 && el.clientHeight > 300 && el.scrollHeight > el.clientHeight + 100;
        });
        if (sc) sc.scrollTop = sc.scrollHeight;
        let count = 0;
        for (const el of document.querySelectorAll('div[draggable="true"]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 30 && r.left < innerWidth * 0.4) count++;
        }
        return { count, hasScroller: !!sc };
      })()`);
      if (!res || !res.hasScroller) return;  // 列表未超一屏，已全量挂载
      await sleep(900);
      if (res.count === last) stable++; else { stable = 0; last = res.count; }
    }
  }

  // 按枚举顺序取第 index 个视频瓦片的点击坐标；瓦片可能在视口外，
  // 先 scrollIntoView 再取坐标（instant 滚动同步更新布局，一次 evaluate 即可）
  async function getVideoTileRectByIndex(index) {
    return evaluate(`(() => {
      const vw = innerWidth;
      const isDur = (el) => [...el.querySelectorAll('*')].some(c =>
        c.children.length === 0 && /^\\d+(\\.\\d+)?s$/.test((c.textContent||'').trim()));
      const tiles = [];
      for (const el of document.querySelectorAll('div[draggable="true"]')) {
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height > 30 && r.left < vw * 0.4 && isDur(el)) tiles.push(el);
      }
      const el = tiles[${index}];
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
  }

  // 创建一个新页面并导航到它
  async function addOnePageAndNavigate() {
    const before = await readPageInfoRobust();
    const beforeTotal = before ? before.total : 0;
    // 点击末尾 "Add page" 按钮
    const btn = await evaluate(`(() => {
      const all = [...document.querySelectorAll('button[aria-label="Add page"], button[aria-label="添加页面"]')];
      const b = all[all.length - 1];
      if (!b) return null;
      b.scrollIntoView({ block: 'nearest', inline: 'center' });
      const r = b.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
    if (!btn) throw new Error("找不到 Add page 按钮");
    await clickAt(btn.cx, btn.cy);
    // 等待页面数增加
    for (let t = 0; t < 30; t++) {
      await sleep(300);
      const info = await readPageInfoRobust();
      if (info && info.total > beforeTotal) {
        // 导航到新页面（经典设计缩略图可点；视频/Reel 设计新页通常已自动成为当前页，
        // 缩略图点击在该类设计上不生效属已知限制，见 navigateToPage 注释）
        await navigateToPage(info.total);
        return info.total;
      }
    }
    throw new Error("创建页面超时");
  }

  // 进入指定 Folders 文件夹并枚举其中的视频项（只取含时长的视频，跳过图片）
  // 若当前面板已在该文件夹（有视频瓦片）则直接枚举，否则导航进入
  async function enterFolderVideos(folderName, expectedCount) {
    let vids = await getUploadedVideos();
    if (vids.length > 0 && expectedCount && vids.length < expectedCount) {
      // 面板被重挂载回懒加载初态（只挂了首屏），补滚一次
      await scrollPanelToBottom();
      vids = await getUploadedVideos();
    }
    if (vids.length > 0) return vids;
    await openUploadsPanel();
    await sleep(300);
    await switchToFoldersTab();
    await sleep(400);
    const opened = await openFolderByName(folderName);
    if (!opened || !opened.found) return { error: opened ? opened.available : [] };
    await sleep(400);
    await scrollPanelToBottom();
    return await getUploadedVideos();
  }

  // 把指定 Uploads 文件夹里的视频逐个新建页放置（只放视频）
  async function runPlaceVideos(folderName) {
    let ok = 0, failed = 0;
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");

      await openUploadsPanel();
      await sleep(400);
      await switchToFoldersTab();
      await sleep(400);

      const opened = await openFolderByName(folderName);
      if (!opened || !opened.found) {
        const avail = opened && opened.available ? opened.available.join(" / ") : "无";
        log(`未找到名为「${folderName}」的文件夹。现有文件夹：${avail}`);
        send("done", { ok: false });
        return;
      }

      await scrollPanelToBottom();
      const vids = await getUploadedVideos();
      if (vids.length === 0) {
        log(`文件夹「${folderName}」里没有视频（只放视频，图片会跳过）。`);
        send("done", { ok: false });
        return;
      }
      const count = vids.length;
      log(`文件夹「${folderName}」里有 ${count} 个视频，逐个新建页放置。`);

      for (let i = 0; i < count; i++) {
        if (state.cancelled) break;
        send("status", { text: `[${i + 1}/${count}] 新建页…` });

        // 1. 新建一页并导航过去
        let newPageNum;
        try {
          newPageNum = await addOnePageAndNavigate();
          log(`\n[${i + 1}/${count}] 新建第 ${newPageNum} 页`);
        } catch (e) {
          log(`  ✗ 创建页面失败: ${e.message}`);
          failed++;
          continue;
        }

        // 2. 确保仍在该文件夹视图（创建页可能改变面板），按索引取第 i 个
        const cur = await enterFolderVideos(folderName, count);
        if (cur && cur.error) {
          log(`  ✗ 无法回到文件夹「${folderName}」，中止剩余放置`);
          failed++;
          break;
        }
        // 瓦片可能在视口外，取坐标前先 scrollIntoView
        const vid = await getVideoTileRectByIndex(i);
        if (!vid) {
          log(`  ✗ 第 ${i + 1} 个视频项不存在（枚举到 ${cur.length} 个，期望 ${count} 个）`);
          failed++;
          continue;
        }
        await sleep(300);

        send("status", { text: `[${i + 1}/${count}] 放置第 ${i + 1} 个视频…` });
        await clickAt(vid.cx, vid.cy);
        await sleep(1500);  // 等待视频放置到画布
        log(`  ✓ 已放置第 ${i + 1} 个视频到第 ${newPageNum} 页`);
        ok++;

        await pressEscape();
        await sleep(300);
      }

      log(`\n完成：放置 ${ok} 个，失败 ${failed} 个。`);
      send("done", { ok: failed === 0 });
    } catch (e) {
      log("放置视频出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  // —— 字幕位置统一 ——

  // 打开 Position 面板（顶部文字工具栏的常驻按钮，和 Effects/Animate 同排；
  // 实测它不在 "..." More 下拉菜单里——More 是选中元素浮动工具栏上的另一个按钮，
  // 下拉内容只有复制/粘贴/对齐/锁定/删除等，跟 Position 无关，点它对本流程无意义。
  // 中文界面实测该按钮文本为 "调整图层" 且没有 aria-label（Canva 翻译选择，非字面直译）。
  async function openPositionPanel() {
    const posBtn = await evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => ['Position','调整图层'].includes((x.textContent||'').trim()));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
    })()`);
    if (!posBtn) throw new Error("找不到 Position 按钮");
    await clickAt(posBtn.cx, posBtn.cy);
    await sleep(500);
  }

  // Position 面板是否已打开（X 输入框可见）
  function isPositionPanelOpen() {
    return evaluate(`(() => {
      const inputs = document.querySelectorAll('input[aria-labelledby]');
      for (const inp of inputs) {
        const labelId = inp.getAttribute('aria-labelledby');
        const label = labelId ? document.getElementById(labelId) : null;
        if (label && (label.textContent||'').trim() === 'X') {
          const r = inp.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
      }
      return false;
    })()`);
  }

  // 读取 Position 面板的 X/Y 数值（去除 "px" 后缀）
  function readPositionValues() {
    return evaluate(`(() => {
      const inputs = document.querySelectorAll('input[aria-labelledby]');
      let x = null, y = null;
      for (const inp of inputs) {
        const labelId = inp.getAttribute('aria-labelledby');
        const label = labelId ? document.getElementById(labelId) : null;
        if (!label) continue;
        const lt = (label.textContent||'').trim();
        if (lt === 'X') x = inp.value.replace(/[^0-9.\\-]/g, '');
        if (lt === 'Y') y = inp.value.replace(/[^0-9.\\-]/g, '');
      }
      return (x !== null && y !== null) ? { x, y } : null;
    })()`);
  }

  // 获取 X/Y 输入框的屏幕坐标
  function getPositionInputCoords() {
    return evaluate(`(() => {
      const result = {};
      const inputs = document.querySelectorAll('input[aria-labelledby]');
      for (const inp of inputs) {
        const labelId = inp.getAttribute('aria-labelledby');
        const label = labelId ? document.getElementById(labelId) : null;
        if (!label) continue;
        const lt = (label.textContent||'').trim();
        if (lt === 'X' || lt === 'Y') {
          const r = inp.getBoundingClientRect();
          result[lt] = { cx: Math.round(r.x + r.width/2), cy: Math.round(r.y + r.height/2) };
        }
      }
      return (result.X && result.Y) ? result : null;
    })()`);
  }

  async function setPositionForSelected(x, y) {
    const inputs = await getPositionInputCoords();
    if (!inputs) return { applied: false, reason: "no-position-inputs" };

    // 设置 X
    await clickAt(inputs.X.cx, inputs.X.cy);
    await sleep(100);
    await pressSelectAll();
    await sleep(60);
    await typeText(String(x));
    await sleep(60);
    await pressEnter();
    await sleep(200);

    // 设置 Y
    await clickAt(inputs.Y.cx, inputs.Y.cy);
    await sleep(100);
    await pressSelectAll();
    await sleep(60);
    await typeText(String(y));
    await sleep(60);
    await pressEnter();
    await sleep(300);

    return { applied: true };
  }

  async function runReadPosition() {
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");
      await warnIfNoOverlay();

      const texts = await enumerateTexts();
      if (texts.length === 0) {
        log("当前页未找到字幕元素。");
        send("done", { ok: false });
        return;
      }

      const t = texts[0];
      await clickAt(t.cx, t.cy);
      await sleep(300);
      log(`选中「${t.text}」`);

      await openPositionPanel();

      const pos = await readPositionValues();
      if (!pos) {
        log("无法读取位置值。");
        send("done", { ok: false });
        return;
      }

      log(`位置：X=${pos.x}, Y=${pos.y}`);
      send("position-result", { x: pos.x, y: pos.y });

      await pressEscape();
      await sleep(200);
    } catch (e) {
      log("读取位置出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  // 对当前渲染在画布上的这一页执行「枚举文字→逐个设置位置」，返回本页统计
  async function adjustCurrentPagePosition(pageLabel, x, y) {
    let applied = 0, errors = 0;
    const texts = await enumerateTexts();
    log(`${pageLabel}：发现 ${texts.length} 个文字元素。`);

    for (const t of texts) {
      await clickAt(t.cx, t.cy);
      await sleep(300);

      // 复用已打开的面板；未打开则打开
      const panelOpen = await isPositionPanelOpen();
      if (!panelOpen) {
        try {
          await openPositionPanel();
        } catch (e) {
          log(`  ✗ 「${t.text}」无法打开位置面板（${e.message}）`);
          errors++;
          continue;
        }
      }

      const res = await setPositionForSelected(x, y);
      if (res.applied) {
        log(`  ✓ 「${t.text}」→ (${x}, ${y})`);
        applied++;
      } else {
        log(`  ✗ 「${t.text}」设置失败（${res.reason}）`);
        errors++;
      }
    }
    return { applied, errors };
  }

  async function runSetPosition(x, y, allPages) {
    let applied = 0, errors = 0;
    try {
      await chrome.debugger.attach(target, "1.3");
      await cmd("Runtime.enable");
      await warnIfNoOverlay();

      const info = await readPageInfo();

      if (allPages && !info) {
        log(`目标位置 X=${x}, Y=${y}`);
        const ok = await iterateVideoPagesViaCaptions(async (label) => {
          const r = await adjustCurrentPagePosition(label, x, y);
          applied += r.applied; errors += r.errors;
        });
        if (!ok) {
          send("done", { ok: false });
          return;
        }
      } else {
        const total = info ? info.total : 1;
        const startPage = allPages ? 1 : (info ? info.current : 1);
        const endPage = allPages ? total : startPage;
        log(`${allPages ? "所有" : "仅当前"}页（${startPage}–${endPage} / ${total}），目标位置 X=${x}, Y=${y}`);

        for (let i = startPage; i <= endPage; i++) {
          if (state.cancelled) break;
          send("status", { text: `第 ${i} / ${total} 页…` });

          if (allPages) {
            if (!(await navigateToPage(i))) {
              log(`  ✗ 第 ${i} 页：未找到页面缩略图，无法翻页（已尝试切换 Pages 视图），跳过`);
              errors++;
              continue;
            }
          }
          await sleep(400);

          const r = await adjustCurrentPagePosition(`第 ${i} 页`, x, y);
          applied += r.applied; errors += r.errors;
          await pressEscape();
          await sleep(150);
        }
      }

      log(`\n完成：设置 ${applied} 处，失败 ${errors} 处。`);
      send("done", { ok: errors === 0 });
    } catch (e) {
      log("设置位置出错：" + (e && e.message ? e.message : String(e)));
      send("done", { ok: false });
    } finally {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }

  return { run, runAnimate, runProofread, runApplyCorrections, runAddPages, runPlaceVideos, runReadPosition, runSetPosition };
}

// 点击工具栏图标打开侧边栏（常驻，不像 popup 那样一点别处就关闭）
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "run") return;
  // 弹窗关闭 → port 断开 → 置取消标志，运行循环检测后提前退出
  const state = { cancelled: false };
  port.onDisconnect.addListener(() => { state.cancelled = true; });
  port.onMessage.addListener(async (msg) => {
    const runner = makeRunner(msg.tabId, port, state);
    const allPages = msg.allPages !== false;
    if (msg.type === "run") await runner.run(msg.size, msg.threshold, allPages, msg.split || null);
    else if (msg.type === "animate") await runner.runAnimate(msg.color, allPages);
    else if (msg.type === "proofread") await runner.runProofread({ provider: msg.provider, apiKey: msg.apiKey, model: msg.model }, allPages, msg.rules || "");
    else if (msg.type === "apply-corrections") await runner.runApplyCorrections(msg.corrections, allPages);
    else if (msg.type === "add-pages") await runner.runAddPages(msg.count);
    else if (msg.type === "place-videos") await runner.runPlaceVideos(msg.folder);
    else if (msg.type === "read-position") await runner.runReadPosition();
    else if (msg.type === "set-position") await runner.runSetPosition(msg.x, msg.y, allPages);
  });
});
