# Real Payment Gateways (WeChat + Alipay)

This document describes how to enable **real** payment routing in `services/gateway`.

## 1) Required Environment Variables

### Alipay

```bash
ALIPAY_ENABLED=true
ALIPAY_SANDBOX_DEBUG=false
ALIPAY_GATEWAY_URL=https://openapi.alipay.com/gateway.do
ALIPAY_APP_ID=your_alipay_app_id
ALIPAY_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
ALIPAY_ALIPAY_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
ALIPAY_SIGN_TYPE=RSA2

# Optional overrides (recommended in production)
# notify 必须是后端可访问地址（API 域名）
ALIPAY_NOTIFY_URL=https://api.example.com/{app}/v1/payments/callbacks/trade-notify
ALIPAY_AGREEMENT_NOTIFY_URL=https://api.example.com/{app}/v1/payments/callbacks/agreement-notify

# return 可留空，让系统默认走后端中转：
# /{app}/v1/payments/callbacks/trade-return
# 中转会补偿同步订单状态并 302 跳转到前端 /payment/success
# 如需覆盖，必须填写前端地址（不要填写 API 域名）
# ALIPAY_RETURN_URL=https://app.example.com/payment/success
# ALIPAY_AGREEMENT_RETURN_URL=https://app.example.com/payment/agreement/success
```

### Recurring deduction scheduler

The recurring scheduler is disabled by default so a deployment cannot start real withholding unexpectedly.

```bash
PAYMENTS_AUTO_DEDUCTION_ENABLED=true
PAYMENTS_AUTO_DEDUCTION_INTERVAL_MS=300000
PAYMENTS_AUTO_DEDUCTION_BATCH_SIZE=50
```

Behavior:

- The scheduler scans valid Alipay agreements whose `next_deduction_at <= now()`.
- Each agreement is locked in the deduction transaction and checked again before charging.
- `PAYMENTS_AUTO_DEDUCTION_BATCH_SIZE` is clamped to `1..500`.
- `PAYMENTS_AUTO_DEDUCTION_INTERVAL_MS` is clamped to `60000..86400000`.
- Keep this disabled until the Alipay production gateway, callback URLs, and signing callbacks have been verified.

### WeChat Pay (V2 Native)

```bash
WECHAT_PAY_ENABLED=true
WECHAT_PAY_GATEWAY_URL=https://api.mch.weixin.qq.com
WECHAT_PAY_APP_ID=your_wechat_app_id
WECHAT_PAY_MCH_ID=your_mch_id
WECHAT_PAY_API_KEY=your_v2_api_key

# Optional override (recommended in production)
WECHAT_PAY_NOTIFY_URL=https://api.example.com/{app}/v1/payments/callbacks/wechat-notify
```

## 2) API Paths

- Alipay one-time order: `POST /{app}/v1/payments/orders/page-pay`
- Alipay agreement sign: `POST /{app}/v1/payments/agreements/page-sign`
- WeChat native order: `POST /{app}/v1/payments/orders/wechat/native`
- Query order: `GET /{app}/v1/payments/orders/{out_trade_no}`

Callbacks:

- Alipay trade notify: `POST /{app}/v1/payments/callbacks/trade-notify`
- Alipay trade return relay: `GET /{app}/v1/payments/callbacks/trade-return`
- Alipay agreement notify: `POST /{app}/v1/payments/callbacks/agreement-notify`
- WeChat notify: `POST /{app}/v1/payments/callbacks/wechat-notify` (XML)

## 3) Runtime Behavior

- If gateway config is complete:
  - Alipay generates signed form and executes real query/deduction/unsign.
  - WeChat creates real `NATIVE` unified-order and returns `code_url`.
- If gateway config is incomplete:
  - service falls back to mock response for development continuity.

## 4) Deployment Checklist

1. Configure env vars above.
2. Ensure public callback URLs are reachable from Alipay/WeChat servers.
3. Restart `opg-gateway`.
4. In the platform admin (`apps/web`), run payment testing endpoints to validate:
   - one-time payment
   - recurring payment + manual deduction
   - wechat one-time test
5. Confirm order status transitions from `PENDING` -> `PAID` in `/payments/orders/{out_trade_no}`.
6. Enable `PAYMENTS_AUTO_DEDUCTION_ENABLED=true` only after a successful recurring signing callback and manual deduction test.

## 5) Notes

- Current WeChat integration uses **WeChat Pay V2 XML Native** (`/pay/unifiedorder`, `/pay/orderquery`).
- XML callback parsing is enabled in `main.ts`.
- Membership extension + user notification queue is triggered after successful payment write-back.
