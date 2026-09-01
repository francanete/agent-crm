export function resolveActor(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (override?.trim()) return override.trim();
  if (env.AGENTCRM_ACTOR?.trim()) return env.AGENTCRM_ACTOR.trim();
  if (env.AI_AGENT?.trim()) return env.AI_AGENT.trim();
  if (env.PI_CODING_AGENT === 'true') return 'pi';
  return 'human-cli';
}
