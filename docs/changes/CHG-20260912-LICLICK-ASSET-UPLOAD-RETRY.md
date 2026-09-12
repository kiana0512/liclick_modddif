# CHG-20260912-LICLICK-ASSET-UPLOAD-RETRY

## 范围

- 主模块：M03/M04（生图编排）、M12（云端服务边界）。
- 算法：`LICLICK-ASSET-UPLOAD-RETRY` v1.0.0。
- 不改变投影/UV 像素算法、输出分辨率、QA、Project Command/Revision CAS、持久化 Schema 或导出协议。

## 问题与证据

真实 4517 多视图任务在浏览器切到其他页面后，前两组均完成结果恢复、模型回贴、UV 合成和下一组截图提交；第三组在远端任务创建前的参考图上传阶段收到 Atlas HTTP 502（`upstream connect error` / `backend tools/call failed`），随后被立即显示为整批生图失败。该次故障不是隐藏页面渲染生命周期中断。

## 修改

- `upload_asset` 仅对 408、429、5xx、网关/网络超时和明确“暂时异常”执行最多五次指数退避（1、2、4、8 秒）。
- 认证、参数和其他永久错误不重试。
- 成功上传仍使用现有内容哈希 Promise 缓存；最终失败会清除缓存，允许后续重新上传。
- 不对 `generate_image` 做盲重试，因为响应不明确时重试可能创建重复的付费远端任务。

## 验证

- 单元回归覆盖：第三次恢复、退避序列、永久错误单次失败、瞬时错误达到上限后失败。
- 服务端 TypeScript 类型检查和回归套件。
- Web 端多视图顺序、隐藏运行时活性和页面切换链路回归。

## 迁移与回滚

- 无 Schema、资产或项目迁移。
- 回滚时删除 `retryAtlasAssetUpload` 包装与本变更卡即可恢复单次上传；无需处理既有项目数据。
