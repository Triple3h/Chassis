//! 计算稿纸（calc-pad）逻辑层：算式识别、求值与搜索推荐项构造。
//!
//! view 层（Vue）用的是自己的 TS 求值器 `src/core/expr.ts`；这里是逻辑层的第二份实现
//! （搜索源跑在子进程里，拿不到浏览器环境）——**两版一致性由测试向量守护**
//! （`test/expr.test.ts` 的用例逐条搬到 `eval.rs` 的测试里）。

pub mod eval;
pub mod preview;
