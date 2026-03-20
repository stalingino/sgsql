export function handleHealth(headers: Record<string, string>) {
  return new Response(
    JSON.stringify({
      status: "ok",
      version: "0.1.0",
      uptime: process.uptime(),
    }),
    { status: 200, headers },
  );
}
