# 给效率组的 Qwen 配置

用途：LI3D 局部重绘的自动分析与提示词转换。只注入 liclick-server 后端容器。

```dotenv
QWEN3_VL_PLUS_API_BASE_URL=https://llm-proxy.lilith.com/v1
QWEN3_VL_PLUS_API_KEY=<实际密钥通过公司认可的私密渠道单独提供>
QWEN3_VL_PLUS_MODEL=qwen3-vl-plus
QWEN3_VL_PLUS_TIMEOUT_MS=65000
```

后三个非密钥配置（地址、模型、超时）在服务端已有默认值，发布 ConfigMap 也显式设置。
API Key 必須是可以访问该代理和模型的有效密钥，由持有人私下提供，或由效率组申请服务专用密钥。
不要把占位符当成真实值，不写入 Git、Docker ARG、前端 VITE_* 或构建日志。

效率组负责在 GitLab CI/CD 设置受保护、掩码/隐藏变量，并完成运行时注入。

**注入链路已接好（2026-08-25）**：`deploy/prepare-cloud-secret.sh` 在 `deploy:k8s` job 里
`kubectl apply -k` 之前执行，会把 `QWEN3_VL_PLUS_API_KEY`（如果这个 CI/CD 变量存在）追加进
`deploy/k8s/base/secrets/server.env`，跟 `LICLICK_OBJECT_STORAGE_SESSION_TOKEN` 用的是同一个
可选追加模式——变量不存在时静默跳过，不阻塞其他改动的发布。写完的临时文件会被
kustomize 的 `secretGenerator` 读进 `li3d-server-secrets` 这个带哈希后缀的 Secret，
`apply` 之后立即 shred 掉，不需要手改任何已生成的 Secret。

本次代码不包含实际密钥，也未代替效率组执行变量配置。效率组修改发布脚本后，应正常合并其提交。
验收时只检查变量是否存在，日志不要输出值；正式测试由已登录用户调用局部重绘分析。
