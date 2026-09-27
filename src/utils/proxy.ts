/**
 * 出站代理初始化。
 *
 * Node.js 内置 fetch（基于内置 undici）默认不读取 HTTP_PROXY/HTTPS_PROXY
 * 环境变量，因此在需要走代理的网络环境（公司代理、评测容器里的域名白名单
 * 代理等）下，请求会直连失败。进程启动早期调用一次本模块即可让全部基于
 * 全局 dispatcher 的 fetch 调用遵守环境变量代理配置。
 *
 * EnvHttpProxyAgent 自动读取 HTTPS_PROXY/HTTP_PROXY 与 NO_PROXY，
 * 未配置任何代理环境变量时等价于默认直连行为，不会改变原有网络路径。
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

let configured = false;

export function configureProxyFromEnv(): void {
  if (configured) return;
  setGlobalDispatcher(new EnvHttpProxyAgent());
  configured = true;
}
