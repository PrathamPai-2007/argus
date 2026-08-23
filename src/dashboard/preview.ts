import { renderPage } from "./page.ts";

const port = Number(process.env.ARGUS_PREVIEW_PORT ?? 3738);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: () => new Response(renderPage(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  }),
});

console.log(`Argus dashboard preview: http://127.0.0.1:${port}`);
