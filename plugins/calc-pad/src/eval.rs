//! 算式识别与求值（搜索推荐用）—— 与 view 层 `src/core/expr.ts` 同语义的子集。
//!
//! 搜索场景没有上下文：没有变量、没有 `ans`、不支持赋值（`=` 进不了 tokenize）。
//! 其余规则逐条对齐：全角符号、千分位、后缀百分号 / 二元取模、幂右结合、隐式乘法、
//! 函数表与常量、错误文案。
//!
//! 与 view 层的**刻意差异只有三处**（2026-09-17 对拍 57 条用例确认，其余逐字节一致）：
//! ① 不支持 `ans`（没有"上一行结果"可言）；② 不支持 `a = 3` 赋值（`=` 直接不认识）；
//! ③ `mod(10,3)` 这类把 `mod` 当函数名写的错误文案不同（两边都报错，只是用词）。

/// 输入长度上限：再长就不是"随手算一笔"，而是粘进来了一段文本
const MAX_INPUT_CHARS: usize = 80;

// ── 对外接口 ─────────────────────────────────────────────────

/// 输入像不像一个"可以算"的算式（保守判定：宁可漏掉，不可误报）。
///
/// 误报的代价 = 结果列表里凭空多一条推荐（打扰用户），所以先做形态排除
/// （日期 / IP / 版本号这类"有数字有符号但不是算式"的输入），再要求 tokenize
/// 通过、至少 2 个 token（单个 `42` 不推荐）、至少一个数字字面量
/// （挡掉 `e` / `pi` 这种"算得出但更像搜索词"的短输入）。
///
/// 它只负责"形态"；能不能算出来由 [`evaluate`] 兜底 —— 返回 `true` 但求值失败
/// 的输入（如 `1password`）在 [`crate::preview`] 里会被静默丢弃。
pub fn looks_like_expression(input: &str) -> bool {
    let text = input.trim();
    let char_count = text.chars().count();
    if char_count < 3 || char_count > MAX_INPUT_CHARS {
        return false;
    }
    if is_dotted_number_like(text) || is_date_like(text) {
        return false;
    }
    let Ok(tokens) = tokenize(text) else { return false };
    tokens.len() >= 2 && tokens.iter().any(|token| matches!(token, Token::Num(_)))
}

/// 求值：失败返回人话错误（搜索场景只关心成不成功）。
pub fn evaluate(input: &str) -> Result<f64, String> {
    let tokens = tokenize(input)?;
    if tokens.is_empty() {
        return Err("缺少表达式".into());
    }
    let mut parser = Parser { tokens, index: 0 };
    let value = parser.parse_expression()?;
    if let Some(token) = parser.peek(0) {
        return Err(format!("多出来的输入：{}", token_text(token)));
    }
    Ok(value)
}

/// 展示用格式化（对齐 view 层 `src/core/format.ts::formatNumber`）：
/// 千分位 + 最多 12 位小数（尾零去掉）；极大 / 极小数走科学计数法。
pub fn format_number(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "∞".to_string() } else { "-∞".to_string() };
    }
    let cleaned = clean_float(value);
    let abs = cleaned.abs();
    if abs != 0.0 && (abs >= 1e15 || abs < 1e-9) {
        return to_exponential_js(cleaned, 6);
    }
    let fixed = format!("{cleaned:.12}");
    let (int_part, dec_part) = fixed.split_once('.').unwrap_or((fixed.as_str(), ""));
    let decimals = dec_part.trim_end_matches('0');
    if decimals.is_empty() {
        group_integer(int_part)
    } else {
        format!("{}.{}", group_integer(int_part), decimals)
    }
}

// ── 词法 ─────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Name(String),
    /// `+ - * / % ^`（`**` 与 `mod` 都已归一）
    Op(char),
    LParen,
    RParen,
    Comma,
}

fn token_text(token: &Token) -> String {
    match token {
        Token::Num(value) => format!("{value}"),
        Token::Name(name) => name.clone(),
        Token::Op(ch) => ch.to_string(),
        Token::LParen => "(".to_string(),
        Token::RParen => ")".to_string(),
        Token::Comma => ",".to_string(),
    }
}

fn tokenize(input: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch == ' ' || ch == '\t' || ch == '\u{a0}' {
            index += 1;
            continue;
        }
        if ch == '(' || ch == '（' {
            tokens.push(Token::LParen);
            index += 1;
            continue;
        }
        if ch == ')' || ch == '）' {
            tokens.push(Token::RParen);
            index += 1;
            continue;
        }
        if ch == ',' || ch == '，' || ch == '、' {
            tokens.push(Token::Comma);
            index += 1;
            continue;
        }
        if ch == '*' {
            // `**` 与 `^` 等价
            if chars.get(index + 1).copied() == Some('*') {
                tokens.push(Token::Op('^'));
                index += 2;
            } else {
                tokens.push(Token::Op('*'));
                index += 1;
            }
            continue;
        }
        if ch == '×' || ch == '＊' {
            tokens.push(Token::Op('*'));
            index += 1;
            continue;
        }
        if ch == '÷' {
            tokens.push(Token::Op('/'));
            index += 1;
            continue;
        }
        if ch == '＋' {
            tokens.push(Token::Op('+'));
            index += 1;
            continue;
        }
        if ch == '−' || ch == '–' || ch == '－' {
            tokens.push(Token::Op('-'));
            index += 1;
            continue;
        }
        if ch == '+' || ch == '-' || ch == '/' || ch == '%' || ch == '^' {
            tokens.push(Token::Op(ch));
            index += 1;
            continue;
        }
        if let Some((value, end)) = scan_number(&chars, index) {
            tokens.push(Token::Num(value));
            index = end;
            continue;
        }
        if is_name_start(ch) {
            let mut end = index + 1;
            while end < chars.len() && is_name_continue(chars[end]) {
                end += 1;
            }
            let name: String = chars[index..end].iter().collect();
            if name.eq_ignore_ascii_case("mod") {
                tokens.push(Token::Op('%'));
            } else {
                tokens.push(Token::Name(name));
            }
            index = end;
            continue;
        }
        return Err(format!("不认识的符号：{ch}"));
    }
    Ok(tokens)
}

/// 数字字面量：`123` / `1,234` / `.5` / `1.` / `1e-3`（对齐 view 层的 NUMBER_RE）。
fn scan_number(chars: &[char], start: usize) -> Option<(f64, usize)> {
    let mut index = start;
    let mut text = String::new();
    if chars.get(index).is_some_and(|ch| ch.is_ascii_digit()) {
        // 千分位形态优先（`1,234`），不成立退回普通整数（`1`）
        if let Some(end) = scan_grouped_integer(chars, index) {
            text.extend(chars[index..end].iter().filter(|ch| **ch != ',').copied());
            index = end;
        } else {
            let mut end = index;
            while chars.get(end).is_some_and(|ch| ch.is_ascii_digit()) {
                end += 1;
            }
            text.extend(&chars[index..end]);
            index = end;
        }
    } else if chars.get(index).copied() == Some('.') && chars.get(index + 1).is_some_and(|ch| ch.is_ascii_digit()) {
        // `.5`：整数部分为空，交给下面的小数分支
    } else {
        return None;
    }
    if chars.get(index).copied() == Some('.') {
        let mut end = index + 1;
        while chars.get(end).is_some_and(|ch| ch.is_ascii_digit()) {
            end += 1;
        }
        text.extend(&chars[index..end]);
        index = end;
    }
    if matches!(chars.get(index).copied(), Some('e' | 'E')) {
        let mut end = index + 1;
        if matches!(chars.get(end).copied(), Some('+' | '-')) {
            end += 1;
        }
        let digits_start = end;
        while chars.get(end).is_some_and(|ch| ch.is_ascii_digit()) {
            end += 1;
        }
        if end > digits_start {
            text.extend(&chars[index..end]);
            index = end;
        }
    }
    if text.starts_with('.') {
        text.insert(0, '0');
    }
    if text.ends_with('.') {
        text.push('0');
    }
    text.parse::<f64>().ok().map(|value| (value, index))
}

/// 千分位整数 `\d{1,3}(?:,\d{3})+(?!\d)`：命中返回结束位置（对齐 NUMBER_RE 的回退行为）。
fn scan_grouped_integer(chars: &[char], start: usize) -> Option<usize> {
    let mut index = start;
    let mut leading = 0;
    while leading < 3 && chars.get(index).is_some_and(|ch| ch.is_ascii_digit()) {
        index += 1;
        leading += 1;
    }
    if leading == 0 {
        return None;
    }
    let mut groups = 0;
    while chars.get(index).copied() == Some(',') {
        let mut end = index + 1;
        let mut digits = 0;
        while digits < 3 && chars.get(end).is_some_and(|ch| ch.is_ascii_digit()) {
            end += 1;
            digits += 1;
        }
        if digits < 3 {
            break;
        }
        index = end;
        groups += 1;
    }
    // `(?!\d)`：千分位后面不能再紧跟数字（`1,2345` 要退回 `1`）
    if groups == 0 || chars.get(index).is_some_and(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(index)
}

fn is_name_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || ch == '_' || ('\u{4e00}'..='\u{9fff}').contains(&ch)
}

fn is_name_continue(ch: char) -> bool {
    is_name_start(ch) || ch.is_ascii_digit()
}

// ── 语法（递归下降，优先级与 view 层逐条一致）────────────────

struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    fn peek(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.index + offset)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.index).cloned();
        if token.is_some() {
            self.index += 1;
        }
        token
    }

    fn op_at(&self, offset: usize) -> Option<char> {
        match self.peek(offset) {
            Some(Token::Op(op)) => Some(*op),
            _ => None,
        }
    }

    fn starts_with_operand(&self, offset: usize) -> bool {
        matches!(self.peek(offset), Some(Token::Num(_) | Token::Name(_) | Token::LParen))
    }

    fn parse_expression(&mut self) -> Result<f64, String> {
        let mut value = self.parse_term()?;
        loop {
            let Some(op) = self.op_at(0) else { break };
            if op != '+' && op != '-' {
                break;
            }
            self.index += 1;
            let right = self.parse_term()?;
            value = if op == '+' { value + right } else { value - right };
        }
        Ok(value)
    }

    fn parse_term(&mut self) -> Result<f64, String> {
        let mut value = self.parse_unary()?;
        loop {
            match self.op_at(0) {
                Some('*') | Some('/') => {
                    let op = self.op_at(0).unwrap_or('*');
                    self.index += 1;
                    let right = self.parse_unary()?;
                    if op == '/' && right == 0.0 {
                        return Err("除数不能为 0".into());
                    }
                    value = if op == '*' { value * right } else { value / right };
                    continue;
                }
                // 取模：只有 `%` 后面还跟着操作数时才当二元运算符，否则那是后缀百分号
                Some('%') if self.starts_with_operand(1) => {
                    self.index += 1;
                    let right = self.parse_unary()?;
                    if right == 0.0 {
                        return Err("取模的除数不能为 0".into());
                    }
                    value %= right;
                    continue;
                }
                _ => {}
            }
            // 隐式乘法：2pi、2(3+4)
            if self.starts_with_operand(0) {
                value *= self.parse_unary()?;
                continue;
            }
            break;
        }
        Ok(value)
    }

    fn parse_unary(&mut self) -> Result<f64, String> {
        if let Some(op) = self.op_at(0) {
            if op == '-' || op == '+' {
                self.index += 1;
                let value = self.parse_unary()?;
                return Ok(if op == '-' { -value } else { value });
            }
        }
        let value = self.parse_power()?;
        self.parse_percent(value)
    }

    fn parse_power(&mut self) -> Result<f64, String> {
        let base = self.parse_atom()?;
        if self.op_at(0) == Some('^') {
            self.index += 1;
            // 右结合：2^3^2 = 2^9
            return Ok(base.powf(self.parse_unary()?));
        }
        Ok(base)
    }

    /// 后缀百分号：50% → 0.5（连写多个也继续除）
    fn parse_percent(&mut self, value: f64) -> Result<f64, String> {
        let mut out = value;
        while self.op_at(0) == Some('%') && !self.starts_with_operand(1) {
            self.index += 1;
            out /= 100.0;
        }
        Ok(out)
    }

    fn parse_atom(&mut self) -> Result<f64, String> {
        let Some(token) = self.next() else {
            return Err("表达式不完整".into());
        };
        match token {
            Token::Num(value) => Ok(value),
            Token::LParen => {
                let value = self.parse_expression()?;
                match self.next() {
                    Some(Token::RParen) => Ok(value),
                    _ => Err("括号不匹配".into()),
                }
            }
            Token::Name(name) => {
                let lower = name.to_lowercase();
                if function_arity(&lower).is_some() {
                    return self.call_function(&lower, &name);
                }
                if let Some(value) = constant_value(&lower) {
                    return Ok(value);
                }
                Err(format!("未知的变量或函数：{name}"))
            }
            _ => Err(format!("不认识的符号：{}", token_text(&token))),
        }
    }

    fn call_function(&mut self, name: &str, display: &str) -> Result<f64, String> {
        let Some((min, max)) = function_arity(name) else {
            return Err(format!("未知的变量或函数：{display}"));
        };
        if self.next() != Some(Token::LParen) {
            return Err(format!("{name}() 后面要跟括号"));
        }
        let mut args: Vec<f64> = Vec::new();
        if matches!(self.peek(0), Some(Token::RParen)) {
            self.index += 1;
        } else {
            loop {
                args.push(self.parse_expression()?);
                match self.next() {
                    Some(Token::Comma) => continue,
                    Some(Token::RParen) => break,
                    Some(_) => return Err(format!("{name}() 的参数写法有问题")),
                    None => return Err("括号不匹配".into()),
                }
            }
        }
        if args.len() < min || args.len() > max {
            let need = if min == max { min.to_string() } else { format!("{min}~{max}") };
            return Err(format!("{name}() 需要 {need} 个参数"));
        }
        let result = apply_function(name, &args);
        if result.is_nan() {
            return Err(format!("{name}() 的参数超出了定义域"));
        }
        Ok(result)
    }
}

/// 函数 → (最少参数, 最多参数)；与 view 层 FUNCTIONS 表一一对应。
fn function_arity(name: &str) -> Option<(usize, usize)> {
    Some(match name {
        "sqrt" | "abs" | "floor" | "ceil" | "trunc" | "sign" | "sin" | "cos" | "tan" | "asin" | "acos" | "atan"
        | "ln" | "exp" => (1, 1),
        "round" | "log" => (1, 2),
        "pow" | "mod" => (2, 2),
        "min" | "max" | "hypot" => (2, 16),
        _ => return None,
    })
}

fn apply_function(name: &str, args: &[f64]) -> f64 {
    let x = args[0];
    match name {
        "sqrt" => x.sqrt(),
        "abs" => x.abs(),
        "round" => {
            let digits = clamp_digits(args.get(1).copied());
            let scale = 10f64.powi(digits);
            (x * scale).round() / scale
        }
        "floor" => x.floor(),
        "ceil" => x.ceil(),
        "trunc" => x.trunc(),
        // 不用 `signum`：Rust 的 `0.0.signum()` 是 1.0，JS 的 Math.sign(0) 是 0
        "sign" => {
            if x == 0.0 {
                0.0
            } else if x > 0.0 {
                1.0
            } else {
                -1.0
            }
        }
        "min" => args.iter().copied().fold(f64::INFINITY, f64::min),
        "max" => args.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        "pow" => args[0].powf(args[1]),
        "mod" => args[0] % args[1],
        "sin" => x.sin(),
        "cos" => x.cos(),
        "tan" => x.tan(),
        "asin" => x.asin(),
        "acos" => x.acos(),
        "atan" => x.atan(),
        "log" => match args.get(1) {
            Some(base) if base.is_finite() => x.ln() / base.ln(),
            _ => x.log10(),
        },
        "ln" => x.ln(),
        "exp" => x.exp(),
        "hypot" => args.iter().copied().fold(0.0, f64::hypot),
        _ => f64::NAN,
    }
}

/// 对齐 view 层：缺失 / 非有限 → 0；否则截断到 0..=15
fn clamp_digits(digits: Option<f64>) -> i32 {
    match digits {
        Some(value) if value.is_finite() => value.trunc().clamp(0.0, 15.0) as i32,
        _ => 0,
    }
}

fn constant_value(name: &str) -> Option<f64> {
    Some(match name {
        "pi" | "π" => std::f64::consts::PI,
        "e" => std::f64::consts::E,
        "tau" => std::f64::consts::TAU,
        _ => return None,
    })
}

// ── 形态排除 ─────────────────────────────────────────────────

/// `1.2.3` / `192.168.1.1` 这类点分数字（版本号 / IP）：不当算式
/// （不排除的话会被隐式乘法算成一个莫名其妙的小数）
fn is_dotted_number_like(text: &str) -> bool {
    let segments: Vec<&str> = text.split('.').collect();
    segments.len() >= 3
        && segments
            .iter()
            .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()))
}

/// `2024-01-01` / `1/2/2024` 这类日期：不当算式。
/// 只有首段或末段是 4 位（年份）才算日期 —— `10-5-3` 仍是算式。
fn is_date_like(text: &str) -> bool {
    let segments: Vec<&str> = text.split(|ch| ch == '-' || ch == '/').collect();
    if segments.len() != 3 {
        return false;
    }
    let all_digits = segments
        .iter()
        .all(|segment| !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit()));
    if !all_digits {
        return false;
    }
    let lens: Vec<usize> = segments.iter().map(|segment| segment.len()).collect();
    let year_first = lens[0] == 4 && lens[1] <= 2 && lens[2] <= 2;
    let year_last = lens[0] <= 2 && lens[1] <= 2 && lens[2] == 4;
    year_first || year_last
}

// ── 数值格式化（对齐 src/core/format.ts）─────────────────────

/// 消掉二进制浮点噪声（0.1 + 0.2 → 0.3）：12 位小数以内四舍五入。
/// 用 `floor(x + 0.5)` 而不是 `round()` —— 对齐 JS `Math.round` 的语义。
fn clean_float(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    if value.abs() < 1e12 {
        return (value * 1e12 + 0.5).floor() / 1e12;
    }
    value
}

/// JS `toExponential(digits)` 的等价输出：`1.234500e+15` → 去尾零 → `1.2345e+15`
fn to_exponential_js(value: f64, digits: usize) -> String {
    let raw = format!("{value:.digits$e}");
    let (mantissa, exp) = raw.split_once('e').unwrap_or((raw.as_str(), "0"));
    let mantissa = mantissa.trim_end_matches('0').trim_end_matches('.');
    if exp.starts_with('-') {
        format!("{mantissa}e{exp}")
    } else {
        format!("{mantissa}e+{exp}")
    }
}

/// 整数部分加千分位（对应 `\B(?=(\d{3})+(?!\d))`）
fn group_integer(text: &str) -> String {
    let (sign, digits) = match text.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", text),
    };
    let chars: Vec<char> = digits.chars().collect();
    let mut out = String::with_capacity(text.len() + chars.len() / 3);
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && (chars.len() - index) % 3 == 0 {
            out.push(',');
        }
        out.push(*ch);
    }
    format!("{sign}{out}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(expr: &str) -> f64 {
        evaluate(expr).unwrap_or_else(|err| panic!("期望算得出结果：{expr} → {err}"))
    }

    fn error(expr: &str) -> String {
        match evaluate(expr) {
            Err(err) => err,
            Ok(value) => panic!("期望报错，实际算出 {value}：{expr}"),
        }
    }

    // 以下向量逐条搬自 view 层 `test/expr.test.ts`

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(value("55+88+7689*543"), 4175270.0);
        assert_eq!(value("1 + 2 * 3"), 7.0);
        assert_eq!(value("(1 + 2) * 3"), 9.0);
        assert_eq!(value("10 / 4"), 2.5);
        assert_eq!(value("（2＋3）×4"), 20.0);
    }

    #[test]
    fn power_is_right_associative() {
        assert_eq!(value("2^3^2"), 512.0);
        assert_eq!(value("2**10"), 1024.0);
        assert_eq!(value("-3^2"), -9.0);
        assert_eq!(value("(-3)^2"), 9.0);
    }

    #[test]
    fn percent_and_modulo() {
        assert_eq!(value("50%"), 0.5);
        assert_eq!(value("200 * 15%"), 30.0);
        assert_eq!(value("10 % 3"), 1.0);
        assert_eq!(value("10 mod 4"), 2.0);
    }

    #[test]
    fn functions_and_constants() {
        assert_eq!(value("sqrt(16)"), 4.0);
        assert_eq!(value("max(3, 7, 5)"), 7.0);
        assert_eq!(value("min(3, 7, 5)"), 3.0);
        assert_eq!(value("round(3.14159, 2)"), 3.14);
        assert_eq!(value("round(2.5)"), 3.0, "对齐 JS toFixed：half away from zero");
        assert_eq!(value("abs(-8)"), 8.0);
        assert_eq!(value("sign(-.5)"), -1.0);
        assert_eq!(value("sign(0)"), 0.0);
        assert_eq!(value("log(100)"), 2.0);
        assert!(error("sqrt(1, 2)").contains("参数"));
        assert!(error("max(1)").contains("参数"));
        assert!(error("foo(1)").contains("未知的变量或函数"));
        assert!(error("bar + 1").contains("未知的变量或函数"));
        assert!(error("sqrt(-1)").contains("定义域"));
    }

    #[test]
    fn constants_and_implicit_multiplication() {
        assert!((value("2pi") - std::f64::consts::PI * 2.0).abs() < 1e-12);
        assert_eq!(value("2(3+4)"), 14.0);
        assert_eq!(value("1 2 3"), 6.0, "相邻操作数按隐式乘法算");
    }

    #[test]
    fn errors_and_edges() {
        assert_eq!(error("1 / 0"), "除数不能为 0");
        assert_eq!(error("(1 + 2"), "括号不匹配");
        assert_eq!(error("1 + "), "表达式不完整");
        assert_eq!(error("   "), "缺少表达式");
        assert!(error("(1 + 2))").contains("多出来的输入"));
        assert_eq!(value("1,234 + 1"), 1235.0);
        assert!(tokenize("1 & 2").is_err());
        // 搜索场景没有上下文：没有 ans、不支持赋值
        assert!(error("ans + 1").contains("未知的变量或函数"));
        assert!(error("x = 5").contains("不认识的符号"));
    }

    #[test]
    fn gate_accepts_expressions() {
        for input in [
            "10+22",
            "1 + 2 * 3",
            "2^10",
            "sqrt(16)",
            "50%",
            "2(3+4)",
            "（2＋3）×4",
            "10 mod 3",
            "2pi",
            "-5+3",
            "10-5-3",
        ] {
            assert!(looks_like_expression(input), "{input} 应该被当成算式");
        }
    }

    #[test]
    fn gate_rejects_noise() {
        for input in [
            "",
            "  ",
            "微信",
            "safari",
            "mp3",
            "42",
            "1,234",
            "1e5",
            "e",
            "pi",
            "2024-01-01",
            "2024/1/1",
            "1/2/2024",
            "1.2.3",
            "192.168.1.1",
            "1:30",
            "a+b",
            "3d",
        ] {
            assert!(!looks_like_expression(input), "{input} 不该被当成算式");
        }
    }

    #[test]
    fn formats_like_view_layer() {
        assert_eq!(format_number(32.0), "32");
        assert_eq!(format_number(1000001.0), "1,000,001");
        assert_eq!(format_number(-1234.5), "-1,234.5");
        assert_eq!(format_number(0.30000000000000004), "0.3", "消浮点噪声");
        assert_eq!(format_number(1.0 / 3.0), "0.333333333333");
        assert_eq!(format_number(1.0 / 0.0), "∞");
        assert_eq!(format_number(-1.0 / 0.0), "-∞");
        assert_eq!(format_number(f64::NAN), "NaN");
        assert_eq!(format_number(2f64.powi(60)), "1.152922e+18");
        assert_eq!(format_number(5e-10), "5e-10");
        assert_eq!(format_number(0.0), "0");
    }
}
