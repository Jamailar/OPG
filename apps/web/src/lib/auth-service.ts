/**
 * 简单的认证服务
 * 使用 localStorage 存储登录状态和 token
 */
import { runtimeContext } from '@/lib/runtime-context';

class AuthService {
  private readonly TOKEN_KEY = 'access_token';
  private readonly REFRESH_TOKEN_KEY = 'refresh_token';
  private readonly USER_KEY = 'user_info';
  private readonly LEGACY_USER_KEY = 'user';

  private resolveLoginBaseUrl(): string {
    const apiBase = String(runtimeContext.apiBaseUrl || '').trim().replace(/\/+$/, '');
    const appSlug = String(runtimeContext.appSlug || '').trim();
    if (apiBase && appSlug) {
      return `${apiBase}/${appSlug}/v1`;
    }
    return runtimeContext.apiV1BaseUrl;
  }

  private async parseResponse(response: Response): Promise<any> {
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    if (text.trim().toLowerCase().startsWith('<!doctype') || text.trim().startsWith('<html')) {
      throw new Error(
        `API 地址配置错误：${response.url} 返回了 HTML 页面。请在部署环境设置 VITE_API_BASE_URL 指向 gateway-api 域名。`,
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error('登录失败：服务端返回了非 JSON 响应。');
    }
  }

  /**
   * 登录
   */
  async login(email: string, password: string) {
    try {
      const loginBaseUrl = this.resolveLoginBaseUrl();
      if (!loginBaseUrl) {
        throw new Error('未配置 API 地址。请在部署环境设置 VITE_API_BASE_URL 指向 gateway-api 域名。');
      }

      const response = await fetch(`${loginBaseUrl}/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          email,
          username: email,
          password,
        }),
      });

      const data = await this.parseResponse(response);

      if (!response.ok) {
        throw new Error(data?.detail || data?.message || '登录失败');
      }

      if (data.access_token) {
        // 存储 token 和用户信息
        localStorage.setItem(this.TOKEN_KEY, data.access_token);
        if (data.refresh_token) {
          localStorage.setItem(this.REFRESH_TOKEN_KEY, data.refresh_token);
        }
        if (data.user) {
          const serializedUser = JSON.stringify(data.user);
          localStorage.setItem(this.USER_KEY, serializedUser);
          localStorage.setItem(this.LEGACY_USER_KEY, serializedUser);
        }
        return data;
      }

      throw new Error('登录失败：未收到 access_token');
    } catch (error: any) {
      console.error('❌ [AuthService] 登录失败:', error);
      throw error;
    }
  }

  /**
   * 检查是否已登录
   */
  isAuthenticated(): boolean {
    if (typeof window === 'undefined') return false;
    return !!localStorage.getItem(this.TOKEN_KEY);
  }

  /**
   * 获取 token
   */
  getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(this.TOKEN_KEY);
  }

  /**
   * 获取用户信息
   */
  getUser(): any | null {
    if (typeof window === 'undefined') return null;
    const userStr = localStorage.getItem(this.USER_KEY);
    if (!userStr) return null;
    try {
      return JSON.parse(userStr);
    } catch {
      return null;
    }
  }

  /**
   * 退出登录
   */
  logout() {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.REFRESH_TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
    localStorage.removeItem(this.LEGACY_USER_KEY);
  }
}

export const authService = new AuthService();
