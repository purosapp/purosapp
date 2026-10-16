import { parse } from 'acorn'
import type { Expression, Statement, Pattern, VariableDeclaration } from 'acorn'

export type EquationState = Record<string, number | number[]>
export type Equation = (state: EquationState) => EquationState
type Context = { state: EquationState; locals: Record<string, number>; iterations: number }
type Value = (context: Context) => number
type Action = (context: Context) => void
type Reference = { get: Value; set: (context: Context, value: number) => number }

const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key)

const EPSILON = 0.00001
const rand = (x: number) => Math.random() * (Math.floor(x) < 1 ? 1 : Math.floor(x))
// Match Butterchurn's presetBase helpers, including EEL's tolerant comparisons.
const helpers: Record<string, (...args: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, atan2: Math.atan2, abs: Math.abs, exp: Math.exp, log: Math.log,
  log10: Math.log10, floor: Math.floor, int: Math.floor, ceil: Math.ceil,
  min: Math.min, max: Math.max, sign: x => x > 0 ? 1 : x < 0 ? -1 : 0, sqr: x => x * x,
  sqrt: x => Math.sqrt(Math.abs(x)),
  pow: (x, y) => { const z = Math.pow(x, y); return Number.isFinite(z) ? z : 0 },
  div: (x, y) => y === 0 ? 0 : x / y,
  mod: (x, y) => y === 0 ? 0 : Math.floor(x) % Math.floor(y),
  rand, randint: x => Math.floor(rand(x)),
  bnot: x => Math.abs(x) < EPSILON ? 1 : 0,
  bor: (x, y) => Math.abs(x) > EPSILON || Math.abs(y) > EPSILON ? 1 : 0,
  band: (x, y) => Math.abs(x) > EPSILON && Math.abs(y) > EPSILON ? 1 : 0,
  equal: (x, y) => Math.abs(x - y) < EPSILON ? 1 : 0,
  above: (x, y) => x > y ? 1 : 0, below: (x, y) => x < y ? 1 : 0,
  bitor: (x, y) => Math.floor(x) | Math.floor(y),
  bitand: (x, y) => Math.floor(x) & Math.floor(y),
  sigmoid: (x, y) => { const t = 1 + Math.exp(-x * y); return Math.abs(t) > EPSILON ? 1 / t : 0 },
}

const mathFunctions: Record<string, (...args: number[]) => number> = {
  ...helpers, sqrt: Math.sqrt, pow: Math.pow, random: Math.random,
  round: Math.round, trunc: Math.trunc, log2: Math.log2, sinh: Math.sinh,
  cosh: Math.cosh, tanh: Math.tanh,
}
const mathConstants: Record<string, number> = { PI: Math.PI, E: Math.E, LOG10E: Math.LOG10E, LN2: Math.LN2 }

function safeKey(key: string): string {
  if (!/^[A-Za-z_]\w*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
    throw new Error(`Unsupported equation variable: ${key}`)
  }
  return key
}

function binary(operator: string, left: number, right: number): number {
  switch (operator) {
    case '+': return left + right
    case '-': return left - right
    case '*': return left * right
    case '/': return left / right
    case '%': return left % right
    case '**': return left ** right
    case '<': return Number(left < right)
    case '>': return Number(left > right)
    case '<=': return Number(left <= right)
    case '>=': return Number(left >= right)
    case '==': case '===': return Number(left === right)
    case '!=': case '!==': return Number(left !== right)
    case '&': return left & right
    case '|': return left | right
    case '^': return left ^ right
    case '<<': return left << right
    case '>>': return left >> right
    case '>>>': return left >>> right
    default: throw new Error(`Unsupported equation operator: ${operator}`)
  }
}

const BINARY_OPERATORS = new Set(['+', '-', '*', '/', '%', '**', '<', '>', '<=', '>=', '==', '===', '!=', '!==', '&', '|', '^', '<<', '>>', '>>>'])

/** Compile arithmetic into closures, never eval/new Function. Presets cannot
 * access the DOM, IPC, global objects, or arbitrary JavaScript functions. */
export function compileEquation(source: string): Equation {
  // EEL uses if() as a lazy ternary, which is a reserved word in JavaScript.
  const program = parse(source.replace(/\bif\s*\(/g, 'eelIf('), { ecmaVersion: 2020 })
  const localNames = new Set<string>()
  const collectLocals = (node: Statement | VariableDeclaration) => {
    if (node.type === 'VariableDeclaration') {
      for (const declaration of node.declarations) {
        if (declaration.id.type !== 'Identifier') throw new Error('Unsupported equation declaration')
        localNames.add(safeKey(declaration.id.name))
      }
    } else if (node.type === 'BlockStatement') node.body.forEach(collectLocals)
    else if (node.type === 'ForStatement') {
      if (node.init?.type === 'VariableDeclaration') collectLocals(node.init)
      collectLocals(node.body)
    } else if (node.type === 'DoWhileStatement' || node.type === 'WhileStatement') collectLocals(node.body)
    else if (node.type === 'IfStatement') {
      collectLocals(node.consequent)
      if (node.alternate) collectLocals(node.alternate)
    }
  }
  for (const node of program.body) {
    if (node.type.startsWith('Import') || node.type.startsWith('Export')) throw new Error('Unsupported equation module')
    collectLocals(node as Statement)
  }

  const reference = (node: Expression | Pattern): Reference => {
    if (node.type === 'Identifier') {
      const key = safeKey(node.name)
      if (localNames.has(key)) return {
        get: c => c.locals[key] ?? 0,
        set: (c, value) => (c.locals[key] = value),
      }
      return { get: c => Number(c.state[key] ?? 0), set: (c, value) => (c.state[key] = value) }
    }
    if (node.type === 'MemberExpression') {
      if (node.object.type === 'Identifier' && node.object.name === 'a' && ((!node.computed && node.property.type === 'Identifier') || (node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string'))) {
        const key = safeKey(node.property.type === 'Identifier' ? node.property.name : String((node.property as { value: string }).value))
        return { get: c => Number(c.state[key] ?? 0), set: (c, value) => (c.state[key] = value) }
      }
      // Milkdrop's numeric buffers are the only permitted indexed objects.
      const object = node.object
      if (node.computed && object.type === 'MemberExpression' && !object.computed && object.object.type === 'Identifier' && object.object.name === 'a' && object.property.type === 'Identifier' && ['megabuf', 'gmegabuf'].includes(object.property.name)) {
        const key = object.property.name
        if (node.property.type === 'PrivateIdentifier') throw new Error('Unsupported buffer index')
        const index = expression(node.property)
        const bufferIndex = (c: Context) => Math.max(0, Math.min(1048575, Math.floor(index(c))))
        return {
          get: c => (c.state[key] as number[])[bufferIndex(c)] ?? 0,
          set: (c, value) => ((c.state[key] as number[])[bufferIndex(c)] = value),
        }
      }
    }
    throw new Error('Unsupported equation variable access')
  }

  const expression = (node: Expression): Value => {
    switch (node.type) {
      case 'Literal': {
        if (typeof node.value !== 'number' && typeof node.value !== 'boolean') throw new Error('Equation literals must be numeric')
        const value = Number(node.value)
        return () => value
      }
      case 'Identifier': return reference(node).get
      case 'MemberExpression': {
        if (!node.computed && node.object.type === 'Identifier' && node.object.name === 'Math' && node.property.type === 'Identifier' && hasOwn(mathConstants, node.property.name)) {
          const value = mathConstants[node.property.name]
          return () => value
        }
        return reference(node).get
      }
      case 'AssignmentExpression': {
        const target = reference(node.left)
        const right = expression(node.right)
        if (node.operator === '=') return c => target.set(c, right(c))
        const operator = node.operator.slice(0, -1)
        if (!BINARY_OPERATORS.has(operator)) throw new Error(`Unsupported assignment: ${node.operator}`)
        return c => target.set(c, binary(operator, target.get(c), right(c)))
      }
      case 'UpdateExpression': {
        const target = reference(node.argument)
        const delta = node.operator === '++' ? 1 : -1
        return c => { const old = target.get(c); const value = target.set(c, old + delta); return node.prefix ? value : old }
      }
      case 'BinaryExpression': {
        if (!BINARY_OPERATORS.has(node.operator)) throw new Error(`Unsupported operator: ${node.operator}`)
        if (node.left.type === 'PrivateIdentifier') throw new Error('Unsupported equation operand')
        const left = expression(node.left), right = expression(node.right)
        return c => binary(node.operator, left(c), right(c))
      }
      case 'LogicalExpression': {
        const left = expression(node.left), right = expression(node.right)
        if (node.operator === '&&') return c => left(c) && right(c)
        if (node.operator === '||') return c => left(c) || right(c)
        throw new Error(`Unsupported logical operator: ${node.operator}`)
      }
      case 'UnaryExpression': {
        const value = expression(node.argument)
        switch (node.operator) {
          case '-': return c => -value(c)
          case '+': return c => +value(c)
          case '!': return c => Number(!value(c))
          case '~': return c => ~value(c)
          default: throw new Error(`Unsupported unary operator: ${node.operator}`)
        }
      }
      case 'ConditionalExpression': {
        const test = expression(node.test), yes = expression(node.consequent), no = expression(node.alternate)
        return c => test(c) ? yes(c) : no(c)
      }
      case 'SequenceExpression': {
        const values = node.expressions.map(expression)
        return c => { let result = 0; for (const value of values) result = value(c); return result }
      }
      case 'CallExpression': {
        const callee = node.callee
        const args = node.arguments.map(arg => {
          if (arg.type === 'SpreadElement') throw new Error('Unsupported equation argument')
          return expression(arg)
        })
        if (callee.type === 'Identifier' && callee.name === 'eelIf' && args.length === 3) {
          return c => args[0](c) ? args[1](c) : args[2](c)
        }
        let fn: ((...args: number[]) => number) | undefined
        if (callee.type === 'Identifier' && hasOwn(helpers, callee.name)) fn = helpers[callee.name]
        else if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'Math' && callee.property.type === 'Identifier' && hasOwn(mathFunctions, callee.property.name)) fn = mathFunctions[callee.property.name]
        if (!fn) throw new Error('Unsupported equation function')
        return c => fn(...args.map(arg => arg(c)))
      }
      default: throw new Error(`Unsupported equation expression: ${node.type}`)
    }
  }

  // Built-ins initialize buffers with 1,048,576 entries; permit those loops.
  const tick = (c: Context) => { if (++c.iterations > 2097152) throw new Error('Equation loop limit exceeded') }
  const statement = (node: Statement): Action => {
    switch (node.type) {
      case 'EmptyStatement': return () => {}
      case 'ExpressionStatement': return expression(node.expression)
      case 'BlockStatement': {
        const actions = node.body.map(statement)
        return c => { for (const action of actions) action(c) }
      }
      case 'VariableDeclaration': {
        const actions = node.declarations.map(declaration => {
          if (!declaration.init) return () => {}
          const target = reference(declaration.id)
          const init = expression(declaration.init)
          return (c: Context) => target.set(c, init(c))
        })
        return c => { for (const action of actions) action(c) }
      }
      case 'IfStatement': {
        const test = expression(node.test), yes = statement(node.consequent), no = node.alternate ? statement(node.alternate) : () => {}
        return c => { if (test(c)) yes(c); else no(c) }
      }
      case 'ForStatement': {
        const init = node.init ? node.init.type === 'VariableDeclaration' ? statement(node.init) : expression(node.init) : () => {}
        const test = node.test ? expression(node.test) : () => 1
        const update = node.update ? expression(node.update) : () => {}
        const body = statement(node.body)
        return c => { for (init(c); test(c); update(c)) { tick(c); body(c) } }
      }
      case 'WhileStatement': case 'DoWhileStatement': {
        const test = expression(node.test), body = statement(node.body)
        return node.type === 'WhileStatement'
          ? c => { while (test(c)) { tick(c); body(c) } }
          : c => { do { tick(c); body(c) } while (test(c)) }
      }
      default: throw new Error(`Unsupported equation statement: ${node.type}`)
    }
  }
  const actions = program.body.map(node => statement(node as Statement))
  return state => {
    const context: Context = { state, locals: Object.create(null), iterations: 0 }
    for (const action of actions) action(context)
    return state
  }
}
