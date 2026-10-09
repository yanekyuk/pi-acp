export function configurePiAgentDirectory(env: NodeJS.ProcessEnv): void {
  if (env.PI_ACP_AGENT_DIR) {
    env.PI_CODING_AGENT_DIR = env.PI_ACP_AGENT_DIR
  } else if (env.PI_CODING_AGENT === 'true') {
    delete env.PI_CODING_AGENT_DIR
  }
}
