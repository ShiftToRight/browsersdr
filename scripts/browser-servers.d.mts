export function browserServers(
  root: string,
  env?: NodeJS.ProcessEnv,
): Array<{
  name: string;
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
}>;
