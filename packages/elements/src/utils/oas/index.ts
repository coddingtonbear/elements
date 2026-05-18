import { slugify } from '@stoplight/elements-core';
import {
  Oas2HttpOperationTransformer,
  Oas2HttpServiceTransformer,
  Oas3HttpEndpointOperationTransformer,
  Oas3HttpServiceTransformer,
  OPERATION_CONFIG,
  WEBHOOK_CONFIG,
} from '@stoplight/http-spec/oas';
import { transformOas2Operation, transformOas2Service } from '@stoplight/http-spec/oas2';
import { transformOas3Operation, transformOas3Service } from '@stoplight/http-spec/oas3';
import { encodePointerFragment, pointerToPath } from '@stoplight/json';
import { IHttpOperation, IHttpWebhookOperation, NodeType } from '@stoplight/types';
import { get, isObject, last } from 'lodash';
import { OpenAPIObject as _OpenAPIObject, PathObject } from 'openapi3-ts';
import { Spec } from 'swagger-schema-official';

import { oas2SourceMap } from './oas2';
import { oas3SourceMap } from './oas3';
import { ISourceNodeMap, NodeTypes, ServiceChildNode, ServiceNode } from './types';

// Flattens OAS 3.2 additionalOperations into direct path item keys so the
// standard traversal logic can pick them up without structural changes.
function flattenAdditionalOperations(document: OpenAPIObject): { document: OpenAPIObject; customMethods: string[] } {
  const customMethods = new Set<string>();

  if (!document.paths) {
    return { document, customMethods: [] };
  }

  const newPaths: PathObject = {};
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isObject(pathItem) || !('additionalOperations' in (pathItem as object))) {
      newPaths[path] = pathItem;
      continue;
    }

    const { additionalOperations, ...rest } = pathItem as Record<string, unknown>;
    const newPathItem: Record<string, unknown> = { ...rest };

    if (isObject(additionalOperations)) {
      for (const [method, operation] of Object.entries(additionalOperations as Record<string, unknown>)) {
        const lower = method.toLowerCase();
        customMethods.add(lower);
        newPathItem[lower] = operation;
      }
    }

    newPaths[path] = newPathItem;
  }

  return { document: { ...document, paths: newPaths }, customMethods: [...customMethods] };
}

// Recursively extends all Operation/Webhook entries in a source map with
// additional method names so custom HTTP verbs are recognised during traversal.
function extendSourceMapWithMethods(map: ISourceNodeMap[], methods: string[]): ISourceNodeMap[] {
  if (methods.length === 0) return map;
  const extra = methods.join('|');

  function extendEntry(entry: ISourceNodeMap): ISourceNodeMap {
    if ((entry.type === NodeTypes.Operation || entry.type === NodeTypes.Webhook) && entry.match) {
      return { ...entry, match: `${entry.match}|${extra}` };
    }
    if (entry.children) {
      return { ...entry, children: entry.children.map(extendEntry) };
    }
    return entry;
  }

  return map.map(extendEntry);
}

type OpenAPIObject = _OpenAPIObject & {
  webhooks?: PathObject;
};

type SpecDocument = Spec | OpenAPIObject;

const isOas2 = (parsed: unknown): parsed is Spec =>
  isObject(parsed) &&
  'swagger' in parsed &&
  Number.parseInt(String((parsed as Partial<{ swagger: unknown }>).swagger)) === 2;

const isOas3 = (parsed: unknown): parsed is OpenAPIObject =>
  isObject(parsed) &&
  'openapi' in parsed &&
  Number.parseFloat(String((parsed as Partial<{ openapi: unknown }>).openapi)) >= 3;

const isOas31 = (parsed: unknown): parsed is OpenAPIObject =>
  isObject(parsed) &&
  'openapi' in parsed &&
  Number.parseFloat(String((parsed as Partial<{ openapi: unknown }>).openapi)) === 3.1;

const OAS_MODEL_REGEXP = /((definitions|components)\/?(schemas)?)\//;

export function transformOasToServiceNode(apiDescriptionDocument: unknown) {
  if (isOas31(apiDescriptionDocument)) {
    const base = { ...apiDescriptionDocument, jsonSchemaDialect: 'http://json-schema.org/draft-07/schema#' } as OpenAPIObject;
    const { document, customMethods } = flattenAdditionalOperations(base);
    const map = extendSourceMapWithMethods(oas3SourceMap, customMethods);
    return computeServiceNode(document, map, transformOas3Service, transformOas3Operation);
  }
  if (isOas3(apiDescriptionDocument)) {
    const { document, customMethods } = flattenAdditionalOperations(apiDescriptionDocument as OpenAPIObject);
    const map = extendSourceMapWithMethods(oas3SourceMap, customMethods);
    return computeServiceNode(document, map, transformOas3Service, transformOas3Operation);
  } else if (isOas2(apiDescriptionDocument)) {
    return computeServiceNode(apiDescriptionDocument, oas2SourceMap, transformOas2Service, transformOas2Operation);
  }

  return null;
}

function computeServiceNode(
  document: SpecDocument,
  map: ISourceNodeMap[],
  transformService: Oas2HttpServiceTransformer | Oas3HttpServiceTransformer,
  transformOperation: Oas2HttpOperationTransformer | Oas3HttpEndpointOperationTransformer,
) {
  const serviceDocument = transformService({ document });
  const serviceNode: ServiceNode = {
    type: NodeType.HttpService,
    uri: '/',
    name: serviceDocument.name,
    data: serviceDocument,
    tags: serviceDocument.tags?.map(tag => tag.name) || [],
    children: computeChildNodes(document, document, map, transformOperation),
  };

  return serviceNode;
}

function computeChildNodes(
  document: SpecDocument,
  data: SpecDocument,
  map: ISourceNodeMap[],
  transformer: Oas2HttpOperationTransformer | Oas3HttpEndpointOperationTransformer,
  parentUri: string = '',
) {
  const nodes: ServiceChildNode[] = [];

  if (!isObject(data)) return nodes;

  for (const [key, value] of Object.entries(data)) {
    const sanitizedKey = encodePointerFragment(key);
    const match = findMapMatch(sanitizedKey, map);

    if (match) {
      const uri = `${parentUri}/${sanitizedKey}`;
      const jsonPath = pointerToPath(`#${uri}`);

      if (match.type === NodeTypes.Operation && jsonPath.length === 3) {
        const path = String(jsonPath[1]);
        const method = String(jsonPath[2]);
        const operationDocument = transformer({
          document,
          name: path,
          method,
          config: OPERATION_CONFIG,
        }) as IHttpOperation;
        let parsedUri;
        const encodedPath = String(encodePointerFragment(path));

        if (operationDocument.iid) {
          parsedUri = `/operations/${operationDocument.iid}`;
        } else {
          parsedUri = uri.replace(encodedPath, slugify(path));
        }

        nodes.push({
          type: NodeType.HttpOperation,
          uri: parsedUri,
          data: operationDocument,
          name: operationDocument.summary || operationDocument.iid || operationDocument.path,
          tags: operationDocument.tags?.map(tag => tag.name) || [],
        });
      } else if (match.type === NodeTypes.Webhook && jsonPath.length === 3) {
        const name = String(jsonPath[1]);
        const method = String(jsonPath[2]);
        const webhookDocument = transformer({
          document,
          name,
          method,
          config: WEBHOOK_CONFIG,
        }) as IHttpWebhookOperation;

        let parsedUri;
        const encodedPath = String(encodePointerFragment(name));

        if (webhookDocument.iid) {
          parsedUri = `/webhooks/${webhookDocument.iid}`;
        } else {
          parsedUri = uri.replace(encodedPath, slugify(name));
        }

        nodes.push({
          type: NodeType.HttpWebhook,
          uri: parsedUri,
          data: webhookDocument,
          name: webhookDocument.summary || webhookDocument.name,
          tags: webhookDocument.tags?.map(tag => tag.name) || [],
        });
      } else if (match.type === NodeTypes.Model) {
        const schemaDocument = get(document, jsonPath);
        const parsedUri = uri.replace(OAS_MODEL_REGEXP, 'schemas/');

        nodes.push({
          type: NodeType.Model,
          uri: parsedUri,
          data: schemaDocument,
          name: schemaDocument.title || last(uri.split('/')) || '',
          tags: schemaDocument['x-tags'] || [],
        });
      }

      if (match.children) {
        nodes.push(...computeChildNodes(document, value, match.children, transformer, uri));
      }
    }
  }

  return nodes;
}

function findMapMatch(key: string | number, map: ISourceNodeMap[]): ISourceNodeMap | void {
  if (typeof key === 'number') return;
  for (const entry of map) {
    const escapedKey = key.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');

    if (!!entry.match?.match(escapedKey) || (entry.notMatch !== void 0 && !entry.notMatch.match(escapedKey))) {
      return entry;
    }
  }
}

export function isJson(value: string) {
  try {
    JSON.parse(value);
  } catch (e) {
    return false;
  }
  return true;
}
