(async () => {
  const out = {};
  const desktop = window.desktop;
  out.bridge = {
    reports: typeof desktop?.reports,
    saveFile: typeof desktop?.reports?.saveFile,
    print: typeof desktop?.reports?.print,
    keys: desktop?.reports ? Object.keys(desktop.reports) : null,
  };

  // Проверяем, сколько символов data-URL Chromium соглашается грузить.
  // Именно так главный процесс отдаёт страницу на печать:
  //   webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  const loadDataUrl = (chars) => new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; resolve(value); frame.remove(); };
    frame.onload = () => done({ ok: true, length: frame.contentDocument?.body?.innerText?.length ?? -1 });
    frame.onerror = () => done({ ok: false, reason: "событие error" });
    setTimeout(() => done({ ok: false, reason: "ни onload, ни onerror за 8 с" }), 8000);
    document.body.appendChild(frame);
    frame.src = `data:text/html;charset=utf-8,${encodeURIComponent("я".repeat(chars))}`;
  });

  out.dataUrl = [];
  for (const chars of [100_000, 300_000, 600_000, 800_000, 1_100_000, 1_500_000, 2_400_000, 4_000_000]) {
    const r = await loadDataUrl(chars);
    out.dataUrl.push({ dataUrlChars: `data:text/html;charset=utf-8,${encodeURIComponent("я".repeat(chars))}`.length, ...r });
  }

  // Прямая проверка через fetch: ограничение на длину адреса видно и здесь.
  out.fetchLarge = [];
  for (const chars of [1_500_000, 2_400_000]) {
    const url = `data:text/html;charset=utf-8,${encodeURIComponent("я".repeat(chars))}`;
    try {
      const response = await fetch(url);
      const text = await response.text();
      out.fetchLarge.push({ chars, status: response.status, gotChars: text.length });
    } catch (error) {
      out.fetchLarge.push({ chars, error: String(error).slice(0, 120) });
    }
  }
  return out;
})()