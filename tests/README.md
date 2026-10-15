# Nexus V1 regression tests

The restored V1 source snapshot did not contain the historical 821-test source
files; only the old `test.log` receipt was available. This directory therefore
restores a runnable, source-backed baseline rather than claiming to recreate
missing historical tests.

The current baseline covers the highest-risk coordination boundaries:

- terminal orders, `EXECUTION_UNKNOWN`, hedge/one-way same-leg exclusion;
- bounded market-analysis concurrency;
- bounded current-state opportunity facts and expiry;
- pending-reduction position-state non-reopening;
- control-strategy type compatibility and critical runtime wiring.

`npm test` runs this source-backed baseline. The old receipt remains evidence of
the historical run, but is not treated as a substitute for executable tests.
