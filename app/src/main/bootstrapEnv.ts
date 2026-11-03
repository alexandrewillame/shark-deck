/**
 * Must be the very first thing `index.ts` imports — libuv reads
 * `UV_THREADPOOL_SIZE` only once, when it creates the threadpool on first use,
 * so this has to run before anything (node-hid's `HIDAsync`, `fs.promises`,
 * DNS) touches the pool. electron-vite bundles main as one file evaluated
 * top-to-bottom, so a bare assignment here — imported first — lands before
 * any other module's top-level code can create the pool.
 *
 * Each in-flight `HIDAsync` read/write occupies one threadpool slot for its
 * whole duration (a `read(250)` occupies it for up to 250ms), so a couple of
 * devices polling concurrently can saturate the default pool of 4 and starve
 * unrelated `fs`/DNS work. Doubling it is cheap insurance; it does not by
 * itself fix a slow/unresponsive device, only how many can be in flight at
 * once without blocking everything else.
 */
process.env['UV_THREADPOOL_SIZE'] ??= '8';
