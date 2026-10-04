export async function apiFetch<T = any>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const url = `${import.meta.env.VITE_API_URL || ""}/api${endpoint}`;
  
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });
  
  if (!res.ok) {
    let errorData: any;
    try {
      errorData = await res.json();
    } catch {
      errorData = { error: await res.text() };
    }
    throw Object.assign(new Error(errorData.error || errorData.message || "API request failed"), { status: res.status });
  }
  
  if (res.status === 204) {
    return null as T;
  }
  
  return res.json() as Promise<T>;
}
