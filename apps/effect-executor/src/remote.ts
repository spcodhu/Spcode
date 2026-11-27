import { EffectExecutor } from "./executor.js";
import { GitPullRequestProvider } from "./git-pr-provider.js";
import {
  ArtifactReportProvider,
  DeploymentProvider,
  DnsProvider,
  GitPublisherProvider,
  NginxProvider,
  SystemExecProvider,
} from "./providers.js";

export class HttpEffectExecutor extends EffectExecutor {
  constructor(
    controlUrl: string,
    token: string,
    executorId: string,
    providers?: ConstructorParameters<typeof EffectExecutor>[1],
  ) {
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Spcode-Control-Client": "1",
      "Content-Type": "application/json",
      "X-Spcode-Executor-Id": executorId,
    };
    super(
      {
        async claim() {
          const response = await fetch(new URL("/api/v1/effects/claim", controlUrl), {
            method: "POST",
            headers,
            body: "{}",
          });
          if (!response.ok) throw new Error(`Effect claim failed: ${response.status}`);
          const body = (await response.json()) as { effect: { id: string } | null; request?: any };
          if (!body.effect || !body.request) return null;
          return { effectId: body.effect.id, fence: body.request.fence, request: body.request };
        },
        async complete(effectId, fence, result) {
          const response = await fetch(new URL("/api/v1/effects/complete", controlUrl), {
            method: "POST",
            headers,
            body: JSON.stringify({ effectId, fence, executorId, result }),
          });
          if (!response.ok) throw new Error(`Effect complete failed: ${response.status}`);
        },
      },
      providers ?? new Map(),
    );
  }
}

export function defaultProviders(controlUrl: string, token: string): Map<string, any> {
  const providers = [
    new ArtifactReportProvider(async (body, effectId, fence) => {
      const response = await fetch(new URL("/api/v1/effect-artifacts", controlUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Spcode-Control-Client": "1",
          "Content-Type": "application/json",
          "X-Spcode-Effect-Id": effectId,
          "X-Spcode-Fence": String(fence),
        },
        body,
      });
      if (!response.ok) throw new Error(`Effect report upload failed: ${response.status}`);
      return (await response.json()).id as string;
    }),
    new NginxProvider(),
    new DeploymentProvider(),
    new DnsProvider(),
    new GitPublisherProvider(),
    new GitPullRequestProvider(),
    new SystemExecProvider(),
  ];
  return new Map(providers.map((provider) => [provider.type, provider]));
}
