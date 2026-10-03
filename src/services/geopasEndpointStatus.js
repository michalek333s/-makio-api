/** Sledování stavu jednotlivých GeoPas volání pro UI a diagnostiku. */

export async function trackGeopasCall(name, fn) {
  const started = Date.now();
  try {
    const data = await fn();
    const empty =
      data == null ||
      (Array.isArray(data) && data.length === 0) ||
      (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0);
    return {
      status: {
        name,
        ok: true,
        empty,
        ms: Date.now() - started,
        error: null,
      },
      data,
    };
  } catch (e) {
    return {
      status: {
        name,
        ok: false,
        empty: true,
        ms: Date.now() - started,
        error: e.message || String(e),
      },
      data: null,
    };
  }
}

export function trackWsdpResult(name, result, startedMs = Date.now()) {
  return {
    name,
    ok: Boolean(result?.ok),
    empty: !result?.ok || !result?.data,
    ms: Date.now() - startedMs,
    error: result?.ok ? null : result?.error || 'WSDP selhalo',
    reusedTestSample: Boolean(result?.reusedTestSample),
  };
}
