import { TokenType, createScanner } from './htmlScanner';
import { isEmptyElement } from '../tagProviders/htmlTags';
import { TextDocument } from 'vscode-languageserver-types';
import { REG_SAN_DIRECTIVE, REG_SAN_INTERPOLATIONS } from '../../script/bridge';


interface SanExpression {
    directive?: string;
    event?: string;

    // for val- xxx
    scopedValue?: string;

    start: number;
    end: number;

    value: string;

    // for san-for
    itemName?: string;
    indexName?: string;
    interatorName?: string;
}

type SanAttribute = string | SanExpression


export class Node {
    public tag?: string;
    public closed?: boolean;
    public endTagStart?: number;
    public isInterpolation: boolean;
    public attributes?: { [name: string]: string };
    public sanAttributes?: {
        [k: string]: SanAttribute
    };
    text: string;
    toJSON(this: Node) {
        return {
            ...this,
            parent: null as null,
        };
    }
    public get attributeNames(): string[] {
        if (this.attributes) {
            return Object.keys(this.attributes);
        }

        return [];
    }
    constructor(public start: number, public end: number, public children: Node[], public parent: Node) {
        this.isInterpolation = false;
    }
    public isSameTag(tagInLowerCase: string) {
        return (
            this.tag &&
            tagInLowerCase &&
            this.tag.length === tagInLowerCase.length &&
            this.tag.toLowerCase() === tagInLowerCase
        );
    }
    public get firstChild(): Node {
        return this.children[0];
    }
    public get lastChild(): Node | undefined {
        return this.children.length ? this.children[this.children.length - 1] : void 0;
    }

    public findNodeBefore(offset: number): Node {
        const idx = findFirst(this.children, c => offset <= c.start) - 1;
        if (idx >= 0) {
            const child = this.children[idx];
            if (offset > child.start) {
                if (offset < child.end) {
                    return child.findNodeBefore(offset);
                }
                const lastChild = child.lastChild;
                if (lastChild && lastChild.end === child.end) {
                    return child.findNodeBefore(offset);
                }
                return child;
            }
        }
        return this;
    }

    public findNodeAt(offset: number): Node {
        const idx = findFirst(this.children, c => offset <= c.start) - 1;

        if (idx >= 0) {
            const child = this.children[idx];
            if (offset > child.start && offset <= child.end) {
                return child.findNodeAt(offset);
            }
        } else {
            // so we found the child at index 0
            const child = this.children[0];
            if (child && offset >= child.start && offset <= child.end) {
                return child.findNodeAt(offset);
            }
        }
        return this;
    }
}

export interface HTMLDocument {
    roots: Node[];
    findNodeBefore(offset: number): Node;
    findNodeAt(offset: number): Node;
}

export function parse(text: string): HTMLDocument {
    const scanner = createScanner(text);

    const htmlDocument = new Node(0, text.length, [], null as any);
    let curr = htmlDocument;
    let endTagStart = -1;
    let pendingAttribute = '';
    let token = scanner.scan();
    let attributes: { [k: string]: string } | undefined = {};
    while (token !== TokenType.EOS) {
        switch (token) {
            case TokenType.StartTagOpen:
                const child = new Node(scanner.getTokenOffset(), text.length, [], curr);
                curr.children.push(child);
                curr = child;
                break;
            case TokenType.StartTag:
                curr.tag = scanner.getTokenText();
                break;
            case TokenType.StartTagClose:
                curr.end = scanner.getTokenEnd(); // might be later set to end tag position
                if (isEmptyElement(curr.tag) && curr !== htmlDocument) {
                    curr.closed = true;
                    curr = curr.parent;
                }
                break;
            case TokenType.EndTagOpen:
                endTagStart = scanner.getTokenOffset();
                break;
            case TokenType.EndTag:
                const closeTag = scanner.getTokenText().toLowerCase();
                while (!curr.isSameTag(closeTag) && curr !== htmlDocument) {
                    curr.end = endTagStart;
                    curr.closed = false;
                    curr = curr.parent;
                }
                if (curr !== htmlDocument) {
                    curr.closed = true;
                    curr.endTagStart = endTagStart;
                }
                break;
            case TokenType.StartTagSelfClose:
                if (curr !== htmlDocument) {
                    curr.closed = true;
                    curr.end = scanner.getTokenEnd();
                    curr = curr.parent;
                }
                break;
            case TokenType.EndTagClose:
                if (curr !== htmlDocument) {
                    curr.end = scanner.getTokenEnd();
                    curr = curr.parent;
                }
                break;
            case TokenType.StartInterpolation: {
                const child = new Node(scanner.getTokenOffset(), text.length, [], curr);
                child.isInterpolation = true;
                curr.children.push(child);
                curr = child;
                break;
            }
            case TokenType.EndInterpolation:
                curr.end = scanner.getTokenEnd();
                curr.closed = true;
                curr = curr.parent;
                break;
            case TokenType.AttributeName:
                pendingAttribute = scanner.getTokenText();
                attributes = curr.attributes;
                if (!attributes) {
                    curr.attributes = attributes = {};
                }
                attributes[pendingAttribute] = ''; // Support valueless attributes such as 'checked'
                break;
            case TokenType.AttributeValue:
                const value = scanner.getTokenText();
                const startWithQuote = value[0].match(/"|'/);
                const valueWithOutQuate = startWithQuote ? value.slice(1, -1) : value;

                const attributeValueStart = startWithQuote ? scanner.getTokenOffset() + 1 : scanner.getTokenOffset();
                const attributeValueEnd = startWithQuote ? scanner.getTokenEnd() - 1 : scanner.getTokenEnd();

                if (attributes && pendingAttribute) {

                    if (pendingAttribute.match(REG_SAN_DIRECTIVE)) {
                        curr.sanAttributes = curr.sanAttributes || {};
                        const attributeNode: SanExpression = curr.sanAttributes[pendingAttribute] = {
                            start: attributeValueStart,
                            end: scanner.getTokenEnd(),
                            value: valueWithOutQuate,
                        };
                        const directiveInfo = pendingAttribute.match(REG_SAN_DIRECTIVE);
                        const prefix = directiveInfo[1];

                        if (prefix === 's' || prefix === 'san') {
                            if (directiveInfo[2] == 'if'
                                || directiveInfo[2] == 'elif'
                                || directiveInfo[2] == 'html'
                            ) {
                                if (valueWithOutQuate.indexOf('{{') === -1) {
                                    const interpolationDocument = parse('{{' + valueWithOutQuate + '}}');

                                    interpolationDocument.roots.forEach(function (node) {
                                        node.start += attributeValueStart - 2;
                                        node.end += attributeValueStart - 2;

                                        node.parent = curr;
                                        curr.children.push(node);
                                    });
                                } else {
                                    const interpolationDocument = parse(valueWithOutQuate);

                                    interpolationDocument.roots.forEach(function (node) {
                                        node.start += attributeValueStart;
                                        node.end += attributeValueStart;

                                        node.parent = curr;
                                        curr.children.push(node);
                                    });
                                }
                            } else if (directiveInfo[2] == 'for') {
                                valueWithOutQuate.replace(/^(\s*)([\$0-9a-z_]+)((\s*,\s*)([\$0-9a-z_]+))?(\s+in\s+)(\S+)\s*/ig,
                                    function ($, $1, $item, $3, $4, $index, $6, $accesor) {

                                        const itemStart = attributeValueStart + ($1 || '').length;
                                        const itemNode = new Node(itemStart, itemStart + $item.length, [], curr)
                                        itemNode.isInterpolation = true;
                                        itemNode.text = $item;
                                        curr.children.push(itemNode);
                                        attributeNode.itemName = $item;

                                        if ($index) {
                                            const indexStart = attributeValueStart + [$1 || '', $item, $4 || ''].join('').length;
                                            const indexNode = new Node(indexStart, indexStart + $index.length, [], curr)
                                            indexNode.isInterpolation = true;
                                            indexNode.text = $index;

                                            curr.children.push(indexNode);
                                            attributeNode.indexName = $index;
                                        } else {
                                            attributeNode.indexName = '$index';
                                        }

                                        const iteratorStart = attributeValueStart + [$1 || '', $item, $3 || '', $6 || ''].join('').length
                                        const iteratorNode = new Node(iteratorStart, iteratorStart + $accesor.length, [], curr);
                                        iteratorNode.isInterpolation = true;
                                        iteratorNode.text = $accesor;
                                        curr.children.push(iteratorNode);
                                        attributeNode.interatorName = $accesor;


                                        return '';
                                    });
                            }

                            attributeNode.directive = directiveInfo[2];
                        } else if (prefix == 'on') {
                            attributeNode.event = directiveInfo[2];

                            const eventNode = new Node(attributeValueStart, attributeValueEnd, [], curr);
                            eventNode.isInterpolation = true;
                            curr.children.push(eventNode);

                        } else if (prefix == 'var') {
                            attributeNode.scopedValue = directiveInfo[2];

                            const eventNode = new Node(attributeValueStart, attributeValueEnd, [], curr);
                            eventNode.isInterpolation = true;
                            curr.children.push(eventNode);
                        }
                        curr.sanAttributes[pendingAttribute] = attributeNode;
                    } else if (valueWithOutQuate.match(REG_SAN_INTERPOLATIONS)) {
                        const interpolationDocument = parse(valueWithOutQuate);

                        interpolationDocument.roots.forEach(function (node) {
                            node.start += attributeValueStart;
                            node.end += attributeValueStart;

                            node.parent = curr;
                            curr.children.push(node);
                        });
                    }

                    attributes[pendingAttribute] = value;
                    pendingAttribute = '';
                }

                break;
        }
        token = scanner.scan();
    }
    while (curr !== htmlDocument) {
        curr.end = text.length;
        curr.closed = false;
        curr = curr.parent;
    }
    return {
        roots: htmlDocument.children,
        findNodeBefore: htmlDocument.findNodeBefore.bind(htmlDocument),
        findNodeAt: htmlDocument.findNodeAt.bind(htmlDocument)
    };
}

export function parseHTMLDocument(document: TextDocument): HTMLDocument {
    return parse(document.getText());
}

/**
 * Takes a sorted array and a function p. The array is sorted in such a way that all elements where p(x) is false
 * are located before all elements where p(x) is true.
 * @returns the least x for which p(x) is true or array.length if no element fullfills the given function.
 */
function findFirst<T>(array: T[], p: (x: T) => boolean): number {
    let low = 0,
        high = array.length;
    if (high === 0) {
        return 0; // no children
    }
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (p(array[mid])) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    return low;
}
