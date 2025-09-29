import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (!key) return new Response("Missing key", { status: 400 });

  const store = getStore({ name: "caseconnect" });
  const entry = await store.getWithMetadata(key);
  if (!entry?.value) return new Response("Not found", { status: 404 });

  const type =
    entry?.metadata?.["content-type"] ||
    (key.endsWith(".json") ? "application/json" : "text/plain");

  return new Response(entry.value, { headers: { "content-type": type } });
};

