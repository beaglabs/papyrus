import * as ts from 'typescript'
import { addedLines, indexText, stagedPaths } from '../../../scripts/hooks/git.mjs'

const paths = stagedPaths().filter((path) => path.startsWith('apps/web/src/') && path.endsWith('.tsx'))
const errors = []

function attr(opening, name) {
  return opening.attributes.properties.find((property) => ts.isJsxAttribute(property) && property.name.text === name)
}

function hasAttr(opening, name) {
  return Boolean(attr(opening, name))
}

function attrString(opening, name) {
  const property = attr(opening, name)
  if (!property || !property.initializer) return undefined
  if (ts.isStringLiteral(property.initializer)) return property.initializer.text
  if (ts.isJsxExpression(property.initializer) && property.initializer.expression && ts.isStringLiteral(property.initializer.expression)) return property.initializer.expression.text
  return undefined
}

function tagName(opening) {
  return ts.isIdentifier(opening.tagName) ? opening.tagName.text : opening.tagName.getText()
}

function functionName(node) {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text
  if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) return node.name.text
  return undefined
}

function intersectsAdded(source, node, lineSet) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  for (let line = start; line <= end; line += 1) if (lineSet.has(line)) return true
  return false
}

function accessibleChildren(element) {
  if (!ts.isJsxElement(element)) return false
  return element.children.some((child) => {
    if (ts.isJsxText(child)) return Boolean(child.text.trim())
    if (ts.isJsxExpression(child)) return Boolean(child.expression)
    return true
  })
}

function checkOpening(path, source, opening, owner, lineSet) {
  if (!intersectsAdded(source, opening, lineSet)) return
  const tag = tagName(opening)
  const line = source.getLineAndCharacterOfPosition(opening.getStart(source)).line + 1

  if (tag === 'img' && !hasAttr(opening, 'alt')) errors.push(`${path}:${line}: <img> requires an alt attribute`)

  if (tag === 'a' && attrString(opening, 'target') === '_blank') {
    const rel = attrString(opening, 'rel') ?? ''
    if (!/\b(?:noopener|noreferrer)\b/.test(rel)) errors.push(`${path}:${line}: target="_blank" links require rel="noopener" or rel="noreferrer"`)
  }

  const onClick = hasAttr(opening, 'onClick')
  if (onClick && ['div', 'span', 'section', 'article', 'li', 'p'].includes(tag)) {
    const role = attrString(opening, 'role')
    const keyboard = hasAttr(opening, 'onKeyDown') || hasAttr(opening, 'onKeyUp')
    if (!role || !keyboard || !hasAttr(opening, 'tabIndex')) {
      errors.push(`${path}:${line}: clickable <${tag}> needs an interactive role, keyboard handler, and tabIndex (prefer <button>)`)
    }
  }

  if (tag === 'button') {
    const aria = hasAttr(opening, 'aria-label') || hasAttr(opening, 'aria-labelledby') || hasAttr(opening, 'title')
    if (!aria && owner && !accessibleChildren(owner)) errors.push(`${path}:${line}: <button> requires an accessible name`)
  }
}

for (const path of paths) {
  const text = indexText(path)
  if (text === undefined) continue
  const lines = new Set(addedLines(path).map((item) => item.line))
  if (!lines.size) continue
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  const visit = (node) => {
    if (ts.isJsxElement(node)) checkOpening(path, source, node.openingElement, node, lines)
    else if (ts.isJsxSelfClosingElement(node)) checkOpening(path, source, node, undefined, lines)

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /^use[A-Z0-9]/.test(node.expression.text) && intersectsAdded(source, node, lines)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      let cursor = node.parent
      let owner
      let conditional = false
      while (cursor) {
        if (ts.isFunctionLike(cursor)) { owner = cursor; break }
        if (ts.isIfStatement(cursor) || ts.isConditionalExpression(cursor) || ts.isSwitchStatement(cursor) || ts.isTryStatement(cursor) || ts.isIterationStatement(cursor, false)) conditional = true
        cursor = cursor.parent
      }
      if (conditional) errors.push(`${path}:${line}: React hook ${node.expression.text} may not be called conditionally or in a loop`)
      if (owner) {
        const name = functionName(owner)
        if (name && !/^use[A-Z0-9]/.test(name) && !/^[A-Z]/.test(name)) {
          errors.push(`${path}:${line}: React hook ${node.expression.text} is inside ${name}; hooks belong in components or custom hooks`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

if (errors.length) {
  console.error('Frontend accessibility/React lint failed:')
  for (const error of [...new Set(errors)]) console.error(`  - ${error}`)
  process.exit(1)
}
