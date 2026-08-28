const jobIds = process.argv.slice(2);

if (jobIds.length === 0 || jobIds.some((id) => !/^bake_[a-zA-Z0-9-]+$/.test(id))) {
  console.error('Usage: node scripts/recover-remote-substance-bakes.mjs <bake_job_id> [...]');
  process.exitCode = 2;
} else {
  const service = await import('../apps/server/dist/services/substanceBakeService.js');
  for (const jobId of jobIds) {
    try {
      const job = await service.recoverNormalBakeJobArtifacts(jobId);
      console.log(`${jobId}: ${job.status}, ${Object.keys(job.outputs ?? {}).length} outputs`);
    } catch (error) {
      process.exitCode = 1;
      console.error(`${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
