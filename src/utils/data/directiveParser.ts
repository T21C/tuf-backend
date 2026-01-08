import { IPass } from '../../server/interfaces/models/index.js';
import Level from '../../models/levels/Level.js';
import { logger } from '../../server/services/LoggerService.js';

// Define the available operators and their corresponding JavaScript operators
const OPERATORS = {
  '==': '===',
  '!=': '!==',
  '>': '>',
  '<': '<',
  '>=': '>=',
  '<=': '<=',
  '&&': '&&',
  '||': '||',
  '!': '!',
  '(': '(',
  ')': ')'
} as const;

// Define the available fields and their corresponding getters
const PASS_FIELDS = {
  'BASESCORE': (pass: IPass, level: Level) => level.baseScore || level.difficulty?.baseScore || 0,
  'SCORE': (pass: IPass) => pass.scoreV2 || 0,
  'IS_WF': (pass: IPass) => pass.isWorldsFirst || false,
  'IS_NHT': (pass: IPass) => pass.isNoHoldTap || false,
  'IS_12K': (pass: IPass) => pass.is12K || false,
  'IS_16K': (pass: IPass) => pass.is16K || false,
  'SPEED': (pass: IPass) => pass.speed || 0,
  'ACCURACY': (pass: IPass) => pass.accuracy || 0,
  'NO_MISS': (pass: IPass) => pass.judgements?.earlyDouble === 0
} as const;

// Token types for the parser
type TokenType = 'FIELD' | 'OPERATOR' | 'NUMBER' | 'BOOLEAN' | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

export class DirectiveParser {
  private tokens: Token[] = [];
  private current = 0;

  constructor(private expression: string) {
    this.tokenize();
  }

  private tokenize(): void {
    let position = 0;
    const tokens: Token[] = [];

    while (position < this.expression.length) {
      const char = this.expression[position];

      // Skip whitespace
      if (/\s/.test(char)) {
        position++;
        continue;
      }

      // Check for operators
      if (Object.keys(OPERATORS).some(op => this.expression.startsWith(op, position))) {
        const operator = Object.keys(OPERATORS).find(op =>
          this.expression.startsWith(op, position)
        )!;
        tokens.push({
          type: 'OPERATOR',
          value: operator,
          position
        });
        position += operator.length;
        continue;
      }

      // Check for fields
      if (/[A-Z_][A-Z0-9_]*/.test(char)) {
        const match = this.expression.slice(position).match(/^[A-Z_][A-Z0-9_]*/);
        if (match) {
          tokens.push({
            type: 'FIELD',
            value: match[0],
            position
          });
          position += match[0].length;
          continue;
        }
      }

      // Check for numbers
      if (/[0-9.]/.test(char)) {
        const match = this.expression.slice(position).match(/^[0-9.]+/);
        if (match) {
          tokens.push({
            type: 'NUMBER',
            value: match[0],
            position
          });
          position += match[0].length;
          continue;
        }
      }

      // Check for boolean literals
      if (this.expression.startsWith('true', position) || this.expression.startsWith('false', position)) {
        const value = this.expression.startsWith('true', position) ? 'true' : 'false';
        tokens.push({
          type: 'BOOLEAN',
          value,
          position
        });
        position += value.length;
        continue;
      }

      position++;
    }

    tokens.push({ type: 'EOF', value: '', position });
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.current];
  }

  private advance(): Token {
    return this.tokens[this.current++];
  }

  private match(type: TokenType): boolean {
    if (this.peek().type === type) {
      this.advance();
      return true;
    }
    return false;
  }

  private parseExpression(): string {
    return this.parseLogicalOr();
  }

  private parseLogicalOr(): string {
    let expr = this.parseLogicalAnd();
    while (this.match('OPERATOR') && this.peek().value === '||') {
      expr = `(${expr} || ${this.parseLogicalAnd()})`;
    }
    return expr;
  }

  private parseLogicalAnd(): string {
    let expr = this.parseEquality();
    while (this.match('OPERATOR') && this.peek().value === '&&') {
      expr = `(${expr} && ${this.parseEquality()})`;
    }
    return expr;
  }

  private parseEquality(): string {
    let expr = this.parseComparison();
    while (this.match('OPERATOR') && (this.peek().value === '==' || this.peek().value === '!=')) {
      const operator = this.advance();
      expr = `(${expr} ${OPERATORS[operator.value as keyof typeof OPERATORS]} ${this.parseComparison()})`;
    }
    return expr;
  }

  private parseComparison(): string {
    let expr = this.parsePrimary();
    while (this.match('OPERATOR') && ['>', '<', '>=', '<='].includes(this.peek().value)) {
      const operator = this.advance();
      expr = `(${expr} ${OPERATORS[operator.value as keyof typeof OPERATORS]} ${this.parsePrimary()})`;
    }
    return expr;
  }

  private parsePrimary(): string {
    if (this.match('OPERATOR') && this.peek().value === '!') {
      return `(!${this.parsePrimary()})`;
    }

    if (this.match('OPERATOR') && this.peek().value === '(') {
      this.advance(); // consume '('
      const expr = this.parseExpression();
      if (this.match('OPERATOR') && this.peek().value === ')') {
        this.advance(); // consume ')'
        return `(${expr})`;
      }
      throw new Error('Expected closing parenthesis');
    }

    if (this.peek().type === 'FIELD') {
      const field = this.advance();
      // If we have a field, check if it's followed by an operator
      if (this.peek().type === 'OPERATOR') {
        const operator = this.advance();
        const rightExpr = this.parsePrimary();
        return `(fields.${field.value} ${OPERATORS[operator.value as keyof typeof OPERATORS]} ${rightExpr})`;
      }
      return `fields.${field.value}`;
    }

    if (this.peek().type === 'NUMBER') {
      const number = this.advance();
      return number.value;
    }

    if (this.peek().type === 'BOOLEAN') {
      const boolean = this.advance();
      return boolean.value;
    }

    throw new Error('Unexpected token');
  }

  public parse(): string {
    const expr = this.parseExpression();
    return expr;
  }
}

export function evaluateDirectiveCondition(
  condition: string,
  pass: IPass,
  level: Level
): boolean {
  try {
    // Create a safe evaluation context with properly structured fields
    const fields = {
      BASESCORE: PASS_FIELDS.BASESCORE(pass, level),
      SCORE: PASS_FIELDS.SCORE(pass),
      IS_WF: PASS_FIELDS.IS_WF(pass),
      IS_NHT: PASS_FIELDS.IS_NHT(pass),
      IS_12K: PASS_FIELDS.IS_12K(pass),
      IS_16K: PASS_FIELDS.IS_16K(pass),
      SPEED: PASS_FIELDS.SPEED(pass),
      ACCURACY: PASS_FIELDS.ACCURACY(pass),
      NO_MISS: PASS_FIELDS.NO_MISS(pass)
    };

    // Parse the condition into a safe JavaScript expression
    const parser = new DirectiveParser(condition);
    const expression = parser.parse();

    // Create a safe evaluation function that only has access to the fields object
    const evaluate = new Function('fields', `
      return ${expression};
    `);

    return evaluate(fields);
  } catch (error) {
    logger.error('Error evaluating directive condition:', error);
    return false;
  }
}

// Example usage:
/*
const condition = "BASESCORE >= 100 && (IS_WF || ACCURACY >= 95)";
const result = evaluateDirectiveCondition(condition, pass, level);
*/
