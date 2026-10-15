try {
  const response = await fetch("http://127.0.0.1:3000/api/system/release", {
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  process.exit(0);
} catch {
  // Healthchecks report health only. They must never terminate PID 1:
  // transient auth/DB pressure previously erased the in-memory market facts
  // by turning three slow checks into a self-inflicted restart.
  process.exit(1);
}
