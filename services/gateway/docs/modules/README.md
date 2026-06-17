# 模块文档目录

最后更新：2026-06-17

## 模块索引
| 模块 | Controller 数 | Service 数 | 路由数（自动扫描） |
| --- | ---: | ---: | ---: |
| [`acquisition`](./acquisition/README.md) | 3 | 1 | 9 |
| [`ai-agents`](./ai-agents/README.md) | 2 | 3 | 18 |
| [`ai-chat`](./ai-chat/README.md) | 5 | 12 | 63 |
| [`api-keys`](./api-keys/README.md) | 0 | 1 | 0 |
| [`auth`](./auth/README.md) | 1 | 5 | 36 |
| [`behavior-analytics`](./behavior-analytics/README.md) | 0 | 1 | 0 |
| [`discovery`](./discovery/README.md) | 1 | 1 | 1 |
| [`email-delivery`](./email-delivery/README.md) | 1 | 2 | 2 |
| [`feedback`](./feedback/README.md) | 0 | 1 | 0 |
| [`outbound-proxy`](./outbound-proxy/README.md) | 0 | 2 | 0 |
| [`payments`](./payments/README.md) | 1 | 2 | 34 |
| [`platform-admin`](./platform-admin/README.md) | 2 | 6 | 172 |
| [`redeem`](./redeem/README.md) | 1 | 1 | 1 |
| [`sms`](./sms/README.md) | 0 | 1 | 0 |
| [`tenant-site`](./tenant-site/README.md) | 1 | 1 | 6 |
| [`upload`](./upload/README.md) | 1 | 1 | 6 |
| [`users`](./users/README.md) | 1 | 1 | 52 |

## 维护约定
- 每次模块新增/删除路由后，执行：`npm run docs:modules`
- 每次模块新增公开 Service 方法后，执行：`npm run docs:modules`
- 如自动扫描结果不足，请在对应模块文档手工补充“联调示例”和“业务约束”
