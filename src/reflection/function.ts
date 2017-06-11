import * as binaryen from "../binaryen";
import Class from "./class";
import Compiler from "../compiler";
import { Type, voidType } from "./type";
import { Variable, VariableFlags } from "./variable";
import * as typescript from "../typescript";

export abstract class FunctionBase {
  name: string;
  declaration: typescript.FunctionLikeDeclaration;

  constructor(name: string, declaration: typescript.FunctionLikeDeclaration) {
    this.name = name;
    this.declaration = declaration;
  }

  get isImport(): boolean { return typescript.isImport(this.declaration); }
  get isExport(): boolean { return typescript.isExport(this.declaration); }
  get isInstance(): boolean { return this.declaration.kind === typescript.SyntaxKind.Constructor || this.declaration.kind === typescript.SyntaxKind.MethodDeclaration; }
  get isConstructor(): boolean { return this.declaration.kind === typescript.SyntaxKind.Constructor; }

  toString(): string { return this.name; }
}

export interface FunctionParameter {
  node: typescript.Node;
  name: string;
  type: Type;
  isAlsoProperty?: boolean;
}

/** A function instance with generic parameters resolved. */
export class Function extends FunctionBase {
  typeParameters: { [key: string]: Type };
  parameters: FunctionParameter[];
  returnType: Type;
  parent?: Class;
  body?: typescript.Block | typescript.Expression;

  // set on initialization
  locals: Variable[];
  localsByName: { [key: string]: Variable };
  binaryenParameterTypes: binaryen.Type[];
  binaryenReturnType: binaryen.Type;
  binaryenSignatureId: string;
  binaryenSignature: binaryen.Signature;

  // used in compilation
  breakNumber: number = 0;
  breakDepth: number = 0;

  constructor(name: string, declaration: typescript.FunctionLikeDeclaration, typeParameters: { [key: string]: Type }, parameters: FunctionParameter[], returnType: Type, parent?: Class, body?: typescript.Block | typescript.Expression) {
    super(name, declaration);
    this.typeParameters = typeParameters;
    this.parameters = parameters;
    this.returnType = returnType;
    this.parent = parent;
    this.body = body;
  }

  get breakLabel(): string { return this.breakNumber + "." + this.breakDepth; }

  initialize(compiler: Compiler): void {
    this.binaryenParameterTypes = [];
    this.locals = [];
    this.localsByName = {};
    const ids: string[] = [];

    if (this.isInstance) {
      const variable = new Variable("this", compiler.uintptrType, VariableFlags.none, this.locals.length);
      this.binaryenParameterTypes.push(binaryen.typeOf(compiler.uintptrType, compiler.uintptrSize));
      this.locals.push(variable);
      this.localsByName[variable.name] = variable;
      ids.push(binaryen.identifierOf(compiler.uintptrType, compiler.uintptrSize));
    }

    for (let i = 0, k = this.parameters.length; i < k; ++i) {
      const variable = new Variable(this.parameters[i].name, this.parameters[i].type, VariableFlags.none, this.locals.length);
      this.binaryenParameterTypes.push(binaryen.typeOf(this.parameters[i].type, compiler.uintptrSize));
      this.locals.push(variable);
      this.localsByName[variable.name] = variable;
      ids.push(binaryen.identifierOf(this.parameters[i].type, compiler.uintptrSize));
    }

    this.binaryenReturnType = binaryen.typeOf(this.returnType, compiler.uintptrSize);
    ids.push(binaryen.identifierOf(this.returnType, compiler.uintptrSize));

    this.binaryenSignatureId = ids.join("");
    this.binaryenSignature = compiler.module.getFunctionTypeBySignature(this.binaryenReturnType, this.binaryenParameterTypes);
    if (!this.binaryenSignature)
      this.binaryenSignature = compiler.module.addFunctionType(this.binaryenSignatureId, this.binaryenReturnType, this.binaryenParameterTypes);
  }

  addLocal(name: string, type: Type): Variable {
    const variable = new Variable(name, type, VariableFlags.none, this.locals.length);
    this.locals.push(variable);
    this.localsByName[variable.name] = variable;
    return variable;
  }
}

export { Function as default };

/** A function template with possibly unresolved generic parameters. */
export class FunctionTemplate extends FunctionBase {
  declaration: typescript.FunctionLikeDeclaration;
  instances: { [key: string]: Function } = {};

  constructor(name: string, declaration: typescript.FunctionLikeDeclaration) {
    super(name, declaration);
    this.declaration = declaration;
  }

  get isGeneric(): boolean { return !!(this.declaration.typeParameters && this.declaration.typeParameters.length); }

  resolve(compiler: Compiler, typeArguments: typescript.TypeNode[], parent?: Class): Function {
    const typeParametersCount = this.declaration.typeParameters && this.declaration.typeParameters.length || 0;
    if (typeArguments.length !== typeParametersCount)
      throw Error("type parameter count mismatch");

    let name = this.name;

    const typeParametersMap: { [key: string]: Type } = {};
    if (typeParametersCount) {
      const typeNames: string[] = new Array(typeParametersCount);
      for (let i = 0; i < typeParametersCount; ++i) {
        const parameterDeclaration = (<typescript.NodeArray<typescript.TypeParameterDeclaration>>this.declaration.typeParameters)[i];
        const type = compiler.resolveType(typeArguments[i]);
        typeParametersMap[(<typescript.Identifier>parameterDeclaration.name).getText()] = type;
        typeNames[i] = type.toString();
      }
      name += "<" + typeNames.join(",") + ">";
    }

    if (this.instances[name])
      return this.instances[name];

    const parameters: FunctionParameter[] = new Array(this.declaration.parameters.length);
    for (let i = 0, k = this.declaration.parameters.length; i < k; ++i) {
      const parameter = this.declaration.parameters[i];
      parameters[i] = {
        node: parameter,
        name: parameter.name.getText(),
        type: parameter.type ? typeParametersMap[parameter.name.getText()] || compiler.resolveType(parameter.type) : voidType
      };
      if (!parameter.type && this.declaration.getSourceFile() !== compiler.libraryFile) // library may use 'any'
        compiler.error(parameter.getLastToken(), "Type expected");
    }

    let returnType: Type;
    if (this.isConstructor)
      returnType = compiler.uintptrType;
    else if (this.declaration.type)
      returnType = typeParametersMap[this.declaration.type.getText()] || compiler.resolveType(this.declaration.type, true);
    else {
      returnType = voidType;
      if (this.declaration.getSourceFile() !== compiler.libraryFile) // library may use 'any'
        compiler.warn(<typescript.Identifier>this.declaration.name, "Assuming return type 'void'");
    }

    return this.instances[name] = new Function(name, this.declaration, typeParametersMap, parameters, returnType, parent, this.declaration.body);
  }
}