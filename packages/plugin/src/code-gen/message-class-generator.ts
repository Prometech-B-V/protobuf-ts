import * as ts from "typescript";
import * as rt from "@protobuf-ts/runtime";
import {assert} from "@protobuf-ts/runtime";
import {TypescriptFile} from "../framework/typescript-file";
import {CommentGenerator} from "./comment-generator";
import {createLocalTypeName} from "./local-type-name";
import {Interpreter} from "../interpreter";
import {DescField, DescMessage, DescOneof} from "@bufbuild/protobuf";
import {TypeScriptImports} from "../framework/typescript-imports";
import {SymbolTable} from "../framework/symbol-table";

export class MessageClassGenerator {

    constructor(
      private readonly symbols: SymbolTable,
      private readonly imports: TypeScriptImports,
      private readonly comments: CommentGenerator,
      private readonly interpreter: Interpreter,
      private readonly options: {
          oneofKindDiscriminator: string;
          normalLongType: rt.LongType;
      },
    ) {
    }

    registerSymbols(source: TypescriptFile, descMessage: DescMessage): void {
        // Register class under a distinct kind with a name indicator (suffix) to denote constructor-based class
        const className = createLocalTypeName(descMessage) + 'Ctor';
        this.symbols.register(className, descMessage, source, 'message-class');
    }

    generateMessageClass(source: TypescriptFile, descMessage: DescMessage): ts.ClassDeclaration {
        const
          interpreterType = this.interpreter.getMessageType(descMessage.typeName),
          processedOneofs: string[] = [],
          members: ts.ClassElement[] = [],
          ctorParams: ts.ParameterDeclaration[] = [];

        for (let fieldInfo of interpreterType.fields) {
            const descField = descMessage.fields.find(descField => descField.number === fieldInfo.no);
            assert(descField);
            if (fieldInfo.oneof && descField.oneof) {
                if (processedOneofs.includes(fieldInfo.oneof)) {
                    continue;
                }
                // Create constructor parameter for the OneOf group (ADT union type)
                const [ , , oneofLocalName] = this.oneofInfo(descField.oneof);
                const oneofType = this.createOneofADTTypeNode(source, descField.oneof);
                const param = ts.createParameter(
                  undefined,
                  [ts.createModifier(ts.SyntaxKind.PublicKeyword), ts.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                  undefined,
                  ts.createIdentifier(oneofLocalName),
                  undefined,
                  oneofType,
                  undefined
                );
                this.comments.addCommentsForDescriptor(param, descField.oneof, 'appendToLeadingBlock');
                ctorParams.push(param);
                processedOneofs.push(fieldInfo.oneof);
            } else {
                // Create constructor parameter for a regular field
                const type = this.createTypeNode(source, descField, fieldInfo);
                const param = ts.createParameter(
                  undefined,
                  [ts.createModifier(ts.SyntaxKind.PublicKeyword), ts.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
                  undefined,
                  ts.createIdentifier(fieldInfo.localName),
                  fieldInfo.opt ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
                  type,
                  undefined
                );
                this.comments.addCommentsForDescriptor(param, descField, 'trailingLines');
                ctorParams.push(param);
            }
        }

        // Add constructor with parameter properties only
        members.push(
          ts.createConstructor(
            undefined,
            undefined,
            ctorParams,
            ts.createBlock([], true)
          )
        );

        const statement = ts.createClassDeclaration(
          undefined,
          [ts.createModifier(ts.SyntaxKind.ExportKeyword)],
          this.imports.type(source, descMessage, 'message-class'),
          undefined,
          undefined,
          members
        )

        source.addStatement(statement);
        this.comments.addCommentsForDescriptor(statement, descMessage, 'appendToLeadingBlock');
        return statement;
    }

    /** * NEW HELPER: Calculates the raw TypeNode (e.g., string, number[], MyType)
     * without wrapping it in a Property Declaration/Signature.
     */
    private createTypeNode(source: TypescriptFile, descField: DescField, fieldInfo: rt.FieldInfo): ts.TypeNode {
        let type: ts.TypeNode;

        switch (fieldInfo.kind) {
            case "scalar":
                type = this.createScalarTypeNode(fieldInfo.T, fieldInfo.L);
                break;
            case "enum":
                type = this.createEnumTypeNode(source, fieldInfo.T());
                break;
            case "message":
                type = this.createMessageTypeNode(source, fieldInfo.T());
                break;
            case "map":
                let keyType = fieldInfo.K === rt.ScalarType.BOOL
                  ? ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword)
                  : this.createScalarTypeNode(fieldInfo.K, rt.LongType.STRING);
                let valueType;
                switch (fieldInfo.V.kind) {
                    case "scalar":
                        valueType = this.createScalarTypeNode(fieldInfo.V.T, fieldInfo.V.L);
                        break;
                    case "enum":
                        valueType = this.createEnumTypeNode(source, fieldInfo.V.T());
                        break;
                    case "message":
                        valueType = this.createMessageTypeNode(source, fieldInfo.V.T());
                        break;
                }
                type = ts.createTypeLiteralNode([
                    ts.createIndexSignature(
                      undefined,
                      undefined,
                      [
                          ts.createParameter(
                            undefined,
                            undefined,
                            undefined,
                            ts.createIdentifier('key'),
                            undefined,
                            keyType,
                            undefined
                          )
                      ],
                      valueType
                    )
                ]);
                break;
            default:
                throw new Error("unknown kind " + descField.toString());
        }

        if (fieldInfo.repeat) {
            type = ts.createArrayTypeNode(type);
        }

        return type;
    }

    /**
     * Creates a CLASS property (PropertyDeclaration).
     * Used for top-level fields in the message class.
     */
    private createFieldPropertyDeclaration(source: TypescriptFile, descField: DescField, fieldInfo: rt.FieldInfo): ts.PropertyDeclaration {
        const type = this.createTypeNode(source, descField, fieldInfo);

        // Class properties support decorators (1st arg) and modifiers (2nd arg)
        const property = ts.createProperty(
          undefined,
          [ts.createModifier(ts.SyntaxKind.PublicKeyword), ts.createModifier(ts.SyntaxKind.ReadonlyKeyword), ],
          ts.createIdentifier(fieldInfo.localName),
          fieldInfo.opt ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
          type,
          undefined
        );
        this.comments.addCommentsForDescriptor(property, descField, 'trailingLines');
        return property;
    }

    /**
     * Creates the OneOf property.
     * The property itself is a Class Member (PropertyDeclaration),
     * but the internals use Type Literals (PropertySignature).
     */
    private createOneofADTPropertyDeclaration(source: TypescriptFile, descOneof: DescOneof): ts.PropertyDeclaration {
        const
          oneofCases: ts.TypeLiteralNode[] = [],
          [parentMessageDesc, interpreterType, oneofLocalName] = this.oneofInfo(descOneof),
          memberFieldInfos = interpreterType.fields.filter(fi => fi.oneof === oneofLocalName);

        // create a type for each selection case
        for (let fieldInfo of memberFieldInfos) {

            // { oneofKind: 'fieldName' } - This is part of a type literal, so use PropertySignature
            const kindProperty = ts.createPropertySignature(
              undefined,
              ts.createIdentifier(this.options.oneofKindDiscriminator),
              undefined,
              ts.createLiteralTypeNode(ts.createStringLiteral(fieldInfo.localName)),
              undefined
            );

            // { value: type } - This is part of a type literal, so use PropertySignature
            let descField = parentMessageDesc.fields.find(fd => fd.number === fieldInfo.no);
            assert(descField !== undefined);

            // 1. Get the raw type node
            const typeNode = this.createTypeNode(source, descField, fieldInfo);

            // 2. Manually create a PropertySignature (NOT a PropertyDeclaration)
            const valueProperty = ts.createPropertySignature(
              undefined,
              ts.createIdentifier(fieldInfo.localName),
              fieldInfo.opt ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
              typeNode,
              undefined
            );

            // add this case
            oneofCases.push(
              ts.createTypeLiteralNode([kindProperty, valueProperty])
            );
        }

        // case for no selection: { oneofKind: undefined; }
        oneofCases.push(
          ts.createTypeLiteralNode([
              ts.createPropertySignature(
                undefined,
                ts.createIdentifier(this.options.oneofKindDiscriminator),
                undefined,
                ts.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
                undefined
              )
          ])
        );

        // Final property for the class
        const property = ts.createProperty(
          undefined,
          [ts.createModifier(ts.SyntaxKind.PublicKeyword), ts.createModifier(ts.SyntaxKind.ReadonlyKeyword)],
          ts.createIdentifier(oneofLocalName),
          undefined,
          ts.createUnionTypeNode(oneofCases),
          undefined
        );

        this.comments.addCommentsForDescriptor(property, descOneof, 'appendToLeadingBlock');
        return property;
    }

    // ... [Rest of your helper methods like oneofInfo, createScalarTypeNode, etc. remain the same] ...

    /**
     * Helper to find for a OneofDescriptorProto:
     * [0] the message descriptor
     * [1] a corresponding message type generated by the interpreter
     * [2] the runtime local name of the oneof
     */
    private oneofInfo(descOneof: DescOneof): [DescMessage, rt.IMessageType<rt.UnknownMessage>, string] {
        const parent: DescMessage = descOneof.parent;
        const interpreterType = this.interpreter.getMessageType(parent);
        const sampleField = descOneof.fields[0];
        const sampleFieldInfo = interpreterType.fields.find(fi => fi.no === sampleField.number);
        assert(sampleFieldInfo !== undefined);
        const oneofName = sampleFieldInfo.oneof;
        assert(oneofName !== undefined);
        return [parent, interpreterType, oneofName];
    }

    private createScalarTypeNode(scalarType: rt.ScalarType, longType?: rt.LongType): ts.TypeNode {
        switch (scalarType) {
            case rt.ScalarType.BOOL:
                return ts.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
            case rt.ScalarType.STRING:
                return ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
            case rt.ScalarType.BYTES:
                return ts.createTypeReferenceNode('Uint8Array', undefined);
            case rt.ScalarType.DOUBLE:
            case rt.ScalarType.FLOAT:
            case rt.ScalarType.INT32:
            case rt.ScalarType.FIXED32:
            case rt.ScalarType.UINT32:
            case rt.ScalarType.SFIXED32:
            case rt.ScalarType.SINT32:
                return ts.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
            case rt.ScalarType.SFIXED64:
            case rt.ScalarType.INT64:
            case rt.ScalarType.UINT64:
            case rt.ScalarType.FIXED64:
            case rt.ScalarType.SINT64:
                switch (longType ?? rt.LongType.STRING) {
                    case rt.LongType.STRING:
                        return ts.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
                    case rt.LongType.NUMBER:
                        return ts.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
                    case rt.LongType.BIGINT:
                        return ts.createKeywordTypeNode(ts.SyntaxKind.BigIntKeyword);
                }
        }
    }

    private createMessageTypeNode(source: TypescriptFile, type: rt.IMessageType<rt.UnknownMessage>): ts.TypeNode {
        return ts.createTypeReferenceNode(this.imports.typeByName(source, type.typeName), undefined);
    }

    private createEnumTypeNode(source: TypescriptFile, ei: rt.EnumInfo): ts.TypeNode {
        let [enumTypeName] = ei;
        return ts.createTypeReferenceNode(this.imports.typeByName(source, enumTypeName), undefined);
    }

    private createOneofADTTypeNode(source: TypescriptFile, descOneof: DescOneof): ts.TypeNode {
        const
          oneofCases: ts.TypeLiteralNode[] = [],
          [parentMessageDesc, interpreterType, oneofLocalName] = this.oneofInfo(descOneof),
          memberFieldInfos = interpreterType.fields.filter(fi => fi.oneof === oneofLocalName);

        // create a type for each selection case
        for (let fieldInfo of memberFieldInfos) {
            const kindProperty = ts.createPropertySignature(
              undefined,
              ts.createIdentifier(this.options.oneofKindDiscriminator),
              undefined,
              ts.createLiteralTypeNode(ts.createStringLiteral(fieldInfo.localName)),
              undefined
            );

            let descField = parentMessageDesc.fields.find(fd => fd.number === fieldInfo.no);
            assert(descField !== undefined);

            const typeNode = this.createTypeNode(source, descField, fieldInfo);
            const valueProperty = ts.createPropertySignature(
              undefined,
              ts.createIdentifier(fieldInfo.localName),
              fieldInfo.opt ? ts.createToken(ts.SyntaxKind.QuestionToken) : undefined,
              typeNode,
              undefined
            );

            oneofCases.push(
              ts.createTypeLiteralNode([kindProperty, valueProperty])
            );
        }

        // case for no selection: { oneofKind: undefined; }
        oneofCases.push(
          ts.createTypeLiteralNode([
            ts.createPropertySignature(
              undefined,
              ts.createIdentifier(this.options.oneofKindDiscriminator),
              undefined,
              ts.createKeywordTypeNode(ts.SyntaxKind.UndefinedKeyword),
              undefined
            )
          ])
        );

        return ts.createUnionTypeNode(oneofCases);
    }
}
