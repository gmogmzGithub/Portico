# Update pipeline disk-full harness

`test_reconcile_disk_full_apfs.sh` is a manual, macOS-only verification of the
managed-runtime reconciler's ENOSPC contract. It creates and later deletes a
2 GiB APFS sparse image, seeds a checksummed 300 MiB `webui.db`, places
`TMPDIR` on that same volume, and leaves less free space than the incoming
payload requires.

Run the current safe reconciler:

```bash
tests/manual/test_reconcile_disk_full_apfs.sh
```

The run must report a non-zero reconcile status, identical preserved paths,
an unchanged database checksum, and zero `managed-runtime-reconcile.*`
strands. It also prints both the net APFS usage delta and rsync's cumulative
logical transferred bytes. The latter counts repeated copy/staging passes and
is the deterministic disk-churn comparison; it is not a direct physical-NAND
write measurement.

To observe a historical reconciler without weakening the safety assertions in
the current test, point the harness at an extracted old script and select
legacy mode. All destructive behavior remains confined to the disposable
image:

```bash
HARNESS_MODE=legacy \
RECONCILE_SH=/path/to/old/managed-runtime-reconcile.sh \
tests/manual/test_reconcile_disk_full_apfs.sh
```

The legacy run is observational because the historical bugs can present as a
false success, database mutation, stranded staging directories, or a
combination of those outcomes depending on exactly where the image fills.

For a deterministic write-volume comparison, run both implementations through
an ample-space cycle. Successful rsync invocations report all logical bytes,
including the historical reconciler's repeated staging passes:

```bash
HARNESS_MODE=measure IMAGE_SIZE_GB=4 FREE_SPACE_TARGET_MB=3000 \
tests/manual/test_reconcile_disk_full_apfs.sh

HARNESS_MODE=measure IMAGE_SIZE_GB=4 FREE_SPACE_TARGET_MB=3000 \
RECONCILE_SH=/path/to/old/managed-runtime-reconcile.sh \
tests/manual/test_reconcile_disk_full_apfs.sh
```

Compare `logical_rsync_transferred_bytes` between the two outputs. Disk-full
runs can omit stats for the failed transfer, so they prove failure semantics;
the ample-space runs quantify the structural copy-volume reduction.
