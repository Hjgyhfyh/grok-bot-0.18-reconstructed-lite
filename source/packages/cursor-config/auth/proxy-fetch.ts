// `undici` тянет за собой `@fastify/busboy`, а сцена сборки кладёт в `app.asar`
// только те внешние пакеты, которые бандл требует сам. Статический импорт
// `undici` поднимался при загрузке `main.cjs` и ронял весь модуль до вызова
// `startElectronMainProduction`, поэтому приложение стартовало живым, но без
// окна и без единого сообщения об ошибке. Теперь `undici` грузится лениво, по
// первому реальному запросу, а если модуля нет — используется встроенный `fetch`.
interface UndiciModule {
  readonly ProxyAgent: new (options: { readonly uri: string }) => unknown;
  readonly fetch: (url: string | URL, options?: unknown) => Promise<Response>;
}

let undiciModule: Promise<UndiciModule | null> | undefined;
function loadUndici(): Promise<UndiciModule | null> {
  undiciModule ??= import("undici").then(
    (loaded) => loaded as unknown as UndiciModule,
    () => null,
  );
  return undiciModule;
}

let proxyDispatcher: unknown;
let proxyDispatcherResolved = false;
function resolveProxyDispatcher(undici: UndiciModule): unknown {
  if (proxyDispatcherResolved) return proxyDispatcher;
  proxyDispatcherResolved = true;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
  if (proxyUrl == null || proxyUrl.length === 0) return undefined;
  try { proxyDispatcher = new undici.ProxyAgent({ uri: proxyUrl }); }
  catch { proxyDispatcher = undefined; }
  return proxyDispatcher;
}

export async function proxyFetch(url: string | URL, options?: RequestInit): Promise<Response> {
  const undici = await loadUndici();
  if (undici == null) return await fetch(url, options);
  const dispatcher = resolveProxyDispatcher(undici);
  const undiciOptions = dispatcher === undefined ? options : { ...options, dispatcher };
  return await undici.fetch(url, undiciOptions);
}
