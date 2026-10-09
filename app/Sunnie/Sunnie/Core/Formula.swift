import Foundation

/// The arithmetic a widget may do with its own values, the same language as the server's
/// `api/src/home/formula.ts`: numbers, 'text', true/false, the widget's names, + − × ÷ %,
/// comparisons, && || !, `c ? a : b` and a few functions. No loops, nothing outside the widget.
/// Both must agree on every case in `SunnieTests/FormulaCases.json`.
nonisolated enum Formula {
    enum Value: Equatable, Sendable {
        case number(Double)
        case text(String)
        case bool(Bool)
    }

    indirect enum Node: Sendable {
        case value(Value)
        case name(String)
        case unary(Character, Node)
        case binary(String, Node, Node)
        case cond(Node, Node, Node)
        case call(String, [Node])
    }

    struct Problem: Error {}

    static let functions: Set<String> = ["min", "max", "round", "floor", "ceil", "abs", "if", "clamp", "fixed"]

    private enum Token: Equatable {
        case number(Double), text(String), id(String), op(String)
    }

    private static func tokenize(_ source: String) throws -> [Token] {
        var tokens: [Token] = []
        let chars = Array(source)
        var i = 0
        while i < chars.count {
            let ch = chars[i]
            if ch.isWhitespace { i += 1; continue }
            if ch.isASCII, ch.isNumber || ch == "." {
                var j = i
                while j < chars.count, chars[j].isASCII, chars[j].isNumber { j += 1 }
                if j < chars.count, chars[j] == "." {
                    j += 1
                    while j < chars.count, chars[j].isASCII, chars[j].isNumber { j += 1 }
                }
                var literal = String(chars[i..<j])
                if literal == "." { throw Problem() }
                if literal.hasSuffix(".") { literal += "0" }
                if literal.hasPrefix(".") { literal = "0" + literal }
                guard let n = Double(literal) else { throw Problem() }
                tokens.append(.number(n))
                i = j
                continue
            }
            if ch.isASCII, ch.isLetter || ch == "_" {
                var j = i
                while j < chars.count, chars[j].isASCII, chars[j].isLetter || chars[j].isNumber || chars[j] == "_" { j += 1 }
                tokens.append(.id(String(chars[i..<j])))
                i = j
                continue
            }
            if ch == "'" || ch == "\"" {
                guard let end = chars[(i + 1)...].firstIndex(of: ch) else { throw Problem() }
                tokens.append(.text(String(chars[(i + 1)..<end])))
                i = end + 1
                continue
            }
            if i + 1 < chars.count {
                let two = String(chars[i...(i + 1)])
                if ["==", "!=", "<=", ">=", "&&", "||"].contains(two) { tokens.append(.op(two)); i += 2; continue }
            }
            if "+-*/%<>!?:(),".contains(ch) { tokens.append(.op(String(ch))); i += 1; continue }
            if ch == "×" { tokens.append(.op("*")); i += 1; continue }
            if ch == "÷" { tokens.append(.op("/")); i += 1; continue }
            throw Problem()
        }
        return tokens
    }

    private static let binaryLevels: [[String]] = [["||"], ["&&"], ["==", "!="], ["<", "<=", ">", ">="], ["+", "-"], ["*", "/", "%"]]

    static func parse(_ source: String) throws -> Node {
        guard source.count <= 300 else { throw Problem() }
        let tokens = try tokenize(source)
        var pos = 0
        func isOp(_ v: String) -> Bool { pos < tokens.count && tokens[pos] == .op(v) }
        func expect(_ v: String) throws { guard isOp(v) else { throw Problem() }; pos += 1 }
        func expression(_ depth: Int) throws -> Node {
            guard depth <= 32 else { throw Problem() }
            let c = try binary(0, depth)
            if isOp("?") {
                pos += 1
                let a = try expression(depth + 1)
                try expect(":")
                let b = try expression(depth + 1)
                return .cond(c, a, b)
            }
            return c
        }
        func binary(_ level: Int, _ depth: Int) throws -> Node {
            if level == binaryLevels.count { return try unary(depth) }
            var left = try binary(level + 1, depth)
            while pos < tokens.count, case .op(let op) = tokens[pos], binaryLevels[level].contains(op) {
                pos += 1
                left = .binary(op, left, try binary(level + 1, depth))
            }
            return left
        }
        func unary(_ depth: Int) throws -> Node {
            if isOp("-") || isOp("!") {
                let op: Character = isOp("-") ? "-" : "!"
                pos += 1
                return .unary(op, try unary(depth + 1))
            }
            return try primary(depth)
        }
        func primary(_ depth: Int) throws -> Node {
            guard pos < tokens.count else { throw Problem() }
            let token = tokens[pos]
            pos += 1
            switch token {
            case .number(let n): return .value(.number(n))
            case .text(let s): return .value(.text(s))
            case .id(let name):
                if name == "true" || name == "false" { return .value(.bool(name == "true")) }
                if isOp("(") {
                    guard functions.contains(name) else { throw Problem() }
                    pos += 1
                    var args: [Node] = []
                    if !isOp(")") {
                        repeat {
                            if !args.isEmpty { pos += 1 }
                            args.append(try expression(depth + 1))
                        } while isOp(",")
                    }
                    try expect(")")
                    return .call(name, args)
                }
                return .name(name)
            case .op("("):
                let inner = try expression(depth + 1)
                try expect(")")
                return inner
            case .op:
                throw Problem()
            }
        }
        let node = try expression(0)
        guard pos == tokens.count else { throw Problem() }
        return node
    }

    private static func number(_ v: Value) -> Double {
        switch v {
        case .number(let n): return n
        case .bool(let b): return b ? 1 : 0
        case .text(let s): return Double(s.trimmingCharacters(in: .whitespaces)) ?? 0
        }
    }

    private static func truthy(_ v: Value) -> Bool {
        switch v {
        case .number(let n): return n != 0 && !n.isNaN
        case .text(let s): return !s.isEmpty
        case .bool(let b): return b
        }
    }

    private static func isText(_ v: Value) -> Bool { if case .text = v { true } else { false } }

    /// A name the state does not have is 0; a checklist's name is how many items are ticked.
    static func evaluate(_ node: Node, _ state: [String: StateValue]) -> Value {
        switch node {
        case .value(let v): return v
        case .name(let name):
            switch state[name] {
            case .number(let n): return .number(n)
            case .text(let s): return .text(s)
            case .bool(let b): return .bool(b)
            case .list(let ticks): return .number(Double(ticks.filter { $0 }.count))
            case nil: return .number(0)
            }
        case let .unary(op, a):
            let v = evaluate(a, state)
            return op == "-" ? .number(-number(v)) : .bool(!truthy(v))
        case let .cond(c, a, b):
            return truthy(evaluate(c, state)) ? evaluate(a, state) : evaluate(b, state)
        case let .binary(op, lhs, rhs):
            if op == "&&" { let a = evaluate(lhs, state); return truthy(a) ? evaluate(rhs, state) : a }
            if op == "||" { let a = evaluate(lhs, state); return truthy(a) ? a : evaluate(rhs, state) }
            let a = evaluate(lhs, state), b = evaluate(rhs, state)
            let texts = isText(a) || isText(b)
            switch op {
            case "+": return texts ? .text(display(a) + display(b)) : .number(number(a) + number(b))
            case "-": return .number(number(a) - number(b))
            case "*": return .number(number(a) * number(b))
            case "/": return .number(number(b) == 0 ? 0 : number(a) / number(b))
            case "%": return .number(number(b) == 0 ? 0 : number(a).truncatingRemainder(dividingBy: number(b)))
            case "==": return .bool(texts ? display(a) == display(b) : number(a) == number(b))
            case "!=": return .bool(texts ? display(a) != display(b) : number(a) != number(b))
            case "<": return .bool(number(a) < number(b))
            case "<=": return .bool(number(a) <= number(b))
            case ">": return .bool(number(a) > number(b))
            case ">=": return .bool(number(a) >= number(b))
            default: return .number(0)
            }
        case let .call(name, nodes):
            let args = nodes.map { evaluate($0, state) }
            let n = args.map(number)
            func at(_ i: Int, _ fallback: Double = 0) -> Double { i < n.count ? n[i] : fallback }
            switch name {
            case "min": return .number(n.min() ?? 0)
            case "max": return .number(n.max() ?? 0)
            case "round": return .number(round(at(0), at(1)))
            case "floor": return .number(at(0).rounded(.down))
            case "ceil": return .number(at(0).rounded(.up))
            case "abs": return .number(abs(at(0)))
            case "clamp": return .number(Swift.min(Swift.max(at(0), at(1, -.infinity)), at(2, .infinity)))
            case "if": return truthy(args.first ?? .bool(false)) ? (args.count > 1 ? args[1] : .number(0)) : (args.count > 2 ? args[2] : .number(0))
            case "fixed":
                let digits = Swift.min(Swift.max(Int(at(1)), 0), 6)
                return .text(String(format: "%.\(digits)f", at(0)))
            default: return .number(0)
            }
        }
    }

    /// Half away from zero, as the server rounds.
    static func round(_ value: Double, _ digits: Double) -> Double {
        let d = Swift.min(Swift.max(Int(digits), 0), 6)
        let f = pow(10, Double(d))
        return (abs(value) * f).rounded(.toNearestOrAwayFromZero) / f * (value < 0 ? -1 : 1)
    }

    /// Whole numbers plainly, others with at most two decimals, thousands grouped with commas.
    static func display(_ value: Value) -> String {
        switch value {
        case .text(let s): return s
        case .bool(let b): return b ? "true" : "false"
        case .number(let raw):
            guard raw.isFinite else { return "0" }
            let r = round(raw, 2)
            let magnitude = abs(r)
            var whole: String, fraction = ""
            if magnitude == magnitude.rounded(.towardZero), magnitude < 1e15 {
                whole = String(Int64(magnitude))
            } else {
                let parts = "\(magnitude)".split(separator: ".", maxSplits: 1).map(String.init)
                whole = parts[0]
                if parts.count > 1, parts[1] != "0" { fraction = "." + parts[1] }
            }
            var grouped = ""
            for (i, ch) in whole.reversed().enumerated() {
                if i > 0, i % 3 == 0 { grouped.append(",") }
                grouped.append(ch)
            }
            return (r < 0 ? "-" : "") + String(grouped.reversed()) + fraction
        }
    }

    /// Each `{formula}` in the text replaced by its value; one that does not read shows "—". `{{` is a brace.
    static func interpolate(_ text: String, _ state: [String: StateValue]) -> String {
        guard text.contains("{") else { return text }
        var out = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest.index(after: open)
            if after < rest.endIndex, rest[after] == "{" {
                out += "{"
                rest = rest[rest.index(after: after)...]
                continue
            }
            guard let close = rest[after...].firstIndex(where: { $0 == "}" || $0 == "{" }) else {
                return out + rest[open...]
            }
            // An unclosed brace is just a brace.
            if rest[close] == "{" {
                out += rest[open..<close]
                rest = rest[close...]
                continue
            }
            let source = String(rest[after..<close])
            out += (try? display(evaluate(parse(source), state))) ?? "—"
            rest = rest[rest.index(after: close)...]
        }
        return out + rest
    }

    /// A number field: a number as it is, a formula (braces optional) evaluated and kept within 0…1.
    static func amount(_ source: String, _ state: [String: StateValue]) -> Double {
        var s = source.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("{"), s.hasSuffix("}") { s = String(s.dropFirst().dropLast()) }
        guard let node = try? parse(s) else { return 0 }
        let v = number(evaluate(node, state))
        return v.isFinite ? Swift.min(Swift.max(v, 0), 1) : 0
    }

    /// Whether a part's `when` holds; one that does not read hides the part.
    static func holds(_ source: String, _ state: [String: StateValue]) -> Bool {
        guard let node = try? parse(source) else { return false }
        return truthy(evaluate(node, state))
    }
}
