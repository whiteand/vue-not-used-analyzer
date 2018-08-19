 const acorn = require('acorn')

function parse(codeText) {
  return acorn.parse(codeText, {sourceType: 'module', ecmaVersion: 10})
}

const util = require('util')
const inspect = x => util.inspect(x, {colors: true, depth: 100})
const insplog = x => console.log(inspect(x))
const fs = require('fs')
const p = require('path')
const { compose, equals, path, pathOr, complement, isNil, uniq } = require('ramda')
const R = require('ramda')
const readAllFiles = require('recursive-readdir')

function readFile(filepath) {
    return new Promise((res, rej) => {
        fs.readFile(filepath, (err, data)=>{
            if (err !== null) {
                rej(err)
                return
            }
            res(data.toString())
        })
    })
}

function getActions(text) {
    let actionNameRegexp = /\b(\w+)\b["']?(?=:)/g
    let match = 'Some'
    let res = []
    while (match = actionNameRegexp.exec(text)) {
        res.push(match)
    }
    return res.map(path([1])).filter(complement(isNil))
}

function isInText(text, action) {
    var regular = new RegExp(`\\b${action}\\b`, 'g')
    return text.match(regular)
}
function removeInnerCurlyBracesContent (text) {
    const innerCurlyBracesReg = /(?<={)(.*)(?<=: ){[^}]+?}(.*)(?=})/gms
    let newValue = text.replace(innerCurlyBracesReg, '$1{}$2')
    while (text !== newValue) {
        text = newValue
        newValue = text.replace(innerCurlyBracesReg, '$1{}$2')
    }
    return text
}

async function hasRepeatings (filepath, mapActionsTextReg) {
    try {
        const fileContent = await readFile(filepath)
        const mapActionRegexp = mapActionsTextReg

        const hasActions = mapActionRegexp.test(fileContent)
        if (!hasActions) return {
            filepath,
            hasActions
        }

        const mapActionsText = pathOr('', [0], fileContent.match(mapActionRegexp))
        const actions = uniq(getActions(removeInnerCurlyBracesContent(mapActionsText))).sort()

        const withOutMapText = fileContent.replace(mapActionRegexp, '')
        const unusedAction = actions.filter(action => !isInText(withOutMapText, action))
        return {
            filepath, 
            hasActions,
            actions,
            unusedAction
        }
    } catch (err) {
        console.error({err})
    }
    
}

async function readVueFiles(path) {
  try {
    const isVueFile = compose(
        equals('.vue'),
        f => p.extname(f)
    )
    const files = await readAllFiles(path)
    return files.filter(isVueFile)
  } catch (err) {
    throw err
  }
}

async function doWork(projectPath, unusedInstanceName, reg) {
    try {
        // filepath -> Boolean
        const vueFiles = await readVueFiles(projectPath)
        // /\.\.\.mapGetters\({.*?}\)/gms
        // /\.\.\.mapState\({.*?}\)/gms
        // /\.\.\.mapActions\({.*?}\)/gms

        const repeatings = await Promise.all(vueFiles.map(file=>hasRepeatings(file, reg)))
        const withActions = repeatings.filter(e => e.hasActions)
        const withUnusedActions = withActions.filter(e => e.unusedAction.length)
        const result = withUnusedActions.map(
            elem => `'${elem.filepath}' unused ${unusedInstanceName}: ${elem.unusedAction.join(', ')}`
        ).join('\n')
        const amountOf = withUnusedActions.map(e=>e.unusedAction.length).reduce((x,y)=>x+y, 0)
        console.log(result)
        console.log(`Amount of ${unusedInstanceName}: ${amountOf}`)
    } catch (err) {
        console.error({err})
    }
}

const forEachSyntaxNode = R.curry((action, tree) => {
  if (typeof tree !== 'object') return
  if (tree === null) return
  action(tree)
  Object.keys(tree).forEach(key => {
    forEachSyntaxNode(action, tree[key])
  })
})
function allNodes(tree) {
  let res = [];
  forEachSyntaxNode(n=>res.push(n), tree)
  return res
}
function findExportDefaultNode(tree) {
  return R.head(allNodes(tree).filter(R.propEq('type', 'ExportDefaultDeclaration')))
}
function isNotUsed(name, text) {
  const reg = new RegExp('\\b'+name+'\\b', 'gms')
  return text.search(reg) < 0
}
function findNotUsed(fileContent) {

  const scriptStart = fileContent.search(/(?<=<script>).*?<\/script>/gms)
  const scriptEnd = fileContent.search(/.(?=<\/script>)/gms)

  if (scriptStart < 0) throw 'cannot find beginning of script'
  if (scriptEnd < scriptEnd) throw 'cannot find beginning of script'

  const scriptText = fileContent.slice(scriptStart, scriptEnd)
  try {
    const tree = parse(scriptText)

    const exportDefaultNode = findExportDefaultNode(tree)
    const properties = R.pathOr([], ['declaration', 'properties'], exportDefaultNode)
    if (!properties.length) return []
    const dataProperty = properties.find(R.pathEq(['key', 'name'], 'data'))
    if (!dataProperty) return []

    const dataPropertyValue = dataProperty.value
    let res = []
    if (dataPropertyValue.type !== 'FunctionExpression') {
      res.push('Data property is not a function')
      return res
    }
    const functionStatements = R.path(['body','body'], dataPropertyValue)
    const isReturnStatement = R.allPass([
      R.pathEq(['type'], 'ReturnStatement'),
      R.pathEq(['argument', 'type'], 'ObjectExpression')
    ])
    const returnStatements = R.find(isReturnStatement, functionStatements)
    if (!returnStatements) {
      res.push(`Data doesn't returns object`)
    }
    const dataObjectExpression = R.path(['argument'], returnStatements)
    if (!dataObjectExpression) {
      res.push('data retruned value is not an object')
      return res
    }
    const propertiesNodes = R.pathOr([], ['properties'], dataObjectExpression)
    const propertiesNames = propertiesNodes.map(R.pathOr('', ['key', 'name'])).filter(e => e !== '')
    if (!propertiesNames.length) {
      insp(scriptText.slice(returnStatements.start, returnStatements.end))
      res.push('data has not properties')
      return res
    }
    const textWithoutReturn = fileContent.slice(0, scriptStart)
      +scriptText.slice(0, returnStatements.start)
      +scriptText.slice(returnStatements.end)
      +fileContent.slice(scriptEnd)
    const notUsed = propertiesNames.filter(propName => isNotUsed(propName, textWithoutReturn))
    const notUsedText = notUsed.map(name => `${name} data item is not used`)
    return [...res, ...notUsedText]
  } catch (err) {
    throw err
  }
  return tree
}


async function analyzeDataElements(cont, path) {
  try {
    const notUsedArr = findNotUsed(cont)
    return {
      path,
      notUsed: notUsedArr
    }
  } catch (err) {
    return {
      path,
      err
    }
  }
  
}

async function findNotUsedDataElements(path) {
  try {
    const vueFiles = await readVueFiles(path)
    const fileContents = (await Promise.all(vueFiles.map(e=>readFile(e)))).map(e => e.toString())
    const analyzedFiles = await Promise.all(fileContents.map((cont, ind) => analyzeDataElements(cont, vueFiles[ind])))
    const [withErrors, withoutErrors] = analyzedFiles
      .reduce((arrs, elem) => {
        if (R.has('err', elem)) {
          arrs[0].push(elem)
        } else {
          arrs[1].push(elem)
        }
        return arrs
      }, [[], []])
    const dataAmount = R.sum(withoutErrors.map(R.path(['notUsed', 'length'])))

    const allNotUsedText = withoutErrors.filter(o=>o.notUsed.length > 0).map(({path, notUsed})=>{
      return `'${path}' data problems: ${notUsed.join(', ')}`
    }).join('\n')
    console.log(allNotUsedText)
    console.log(`Amount of data: ${dataAmount}`)
    console.log('Error while or data analyzing:')
    console.log(R.pluck('path', withErrors).join('\n'))
  } catch (err) {
    console.error(err)
  }
}

async function doAllWork(path) {
    await findNotUsedDataElements(path)
    await doWork(path, 'actions', /\.\.\.mapActions\({.*?}\)/gms)
    await doWork(path, 'map states', /\.\.\.mapState\({.*?}\)/gms)
    await doWork(path, 'getters', /\.\.\.mapGetters\({.*?}\)/gms)
}

if (process.argv.length < 3) {
  try {
    const configFile = fs.readFileSync('not-used-config.json').toString()
    const obj = JSON.parse(configFile)
    if (R.isNil(obj)) throw 'Wrong JSON'
    if (R.isNil(obj.projectPath)) throw "Wrong JSON, need 'projectPath' property"
    doAllWork(obj.projectPath)
  } catch (err) {
    console.error('Cannot find `not-used-config.json` file with "projectPath" property')
    console.error(err)
  }
} else {
    const [,,dirPath] = process.argv
    doAllWork(dirPath)
}


