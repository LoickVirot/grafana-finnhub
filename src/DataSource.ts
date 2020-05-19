import { Observable, merge } from 'rxjs';
import {
  CircularDataFrame,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  FieldType,
  TimeSeries,
  TimeRange,
} from '@grafana/data';
import { BackendSrv as BackendService } from '@grafana/runtime';

import { MyQuery, MyDataSourceOptions, defaultQuery, TargetType, QueryParams, CandleQuery } from './types';
import { ensureArray, getTargetType } from './utils';

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  dataSourceName: string;
  token: string;
  baseUrl: string;
  websocketUrl: string;
  sockets: WebSocket[];

  /** @ngInject */
  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>, private backendSrv: BackendService) {
    super(instanceSettings);
    this.dataSourceName = instanceSettings.name;
    const config = instanceSettings.jsonData;
    this.token = config.apiToken;
    this.baseUrl = `https://finnhub.io/api/v1`;
    this.websocketUrl = `wss://ws.finnhub.io?token=${this.token}`;
    this.sockets = [];
  }

  constructQuery(target: Partial<MyQuery & CandleQuery>, range: TimeRange) {
    const symbol = target.symbol?.toUpperCase();
    const refId = { target };
    switch (target.type?.value) {
      case 'candle': {
        const { resolution } = target;
        return { symbol, resolution, from: range.from.unix(), to: range.to.unix(), refId };
      }
      case 'metric':
        return { symbol, metric: target?.metric?.value, refId };
      default:
        return {
          symbol,
          refId,
        };
    }
  }

  closeSockets = () => {
    this.sockets.forEach((socket: WebSocket) => socket.close(1001));
  };

  query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> | Observable<DataQueryResponse> {
    this.closeSockets();
    const { targets, range } = options;
    if (targets[0].type?.value === 'quote') {
      const observables = targets.map(target => {
        const targetWithDefaults = { ...defaultQuery, ...target };
        const query = this.constructQuery(targetWithDefaults, range as TimeRange);
        return new Observable<DataQueryResponse>(subscriber => {
          const frame = new CircularDataFrame({
            append: 'tail',
            capacity: 1000,
          });

          //@ts-ignore
          frame.refId = query.refId;
          frame.addField({ name: 'ts', type: FieldType.time });
          frame.addField({ name: 'value', type: FieldType.number });

          const socket = new WebSocket(this.websocketUrl);
          socket.onopen = () => {
            socket.send(JSON.stringify({ type: 'subscribe', symbol: query.symbol }));
          };

          socket.onerror = (error: any) => console.log(`WebSocket error: ${JSON.stringify(error)}`);
          socket.onclose = () => subscriber.complete();
          socket.onmessage = (event: MessageEvent) => {
            try {
              const data = JSON.parse(event.data);
              if (data.type === 'trade') {
                const { t, p } = data.data[0];
                frame.add({ ts: t, value: p });

                subscriber.next({
                  data: [frame],
                  //@ts-ignore
                  key: query.refId,
                });
              }
            } catch (e) {
              console.error(e);
            }
          };
          this.sockets.push(socket);
        });
      });
      return merge(...observables);
    } else {
      const promises = targets.map(target => {
        const targetWithDefaults = { ...defaultQuery, ...target };
        const { queryText, type } = targetWithDefaults;
        let request;
        // Ignore other query params if there's a free text query
        if (queryText) {
          request = this.freeTextQuery(queryText);
        } else {
          const query = this.constructQuery({ ...defaultQuery, ...target }, range as TimeRange);
          request = this.get(type.value, query);
        }

        // Combine received data and its target
        return request.then(data => {
          const isTable = getTargetType(type) === TargetType.Table;
          if (data.metric) {
            data = data.metric;
          }
          return isTable ? this.tableResponse(ensureArray(data)) : this.tsResponse(data, type.value);
        });
      });
      return Promise.all(promises).then(data => ({ data: data.flat() }));
    }
  }

  tableResponse = (data: any[]) => {
    if (!data.length) {
      return {};
    }
    return {
      columns: Object.entries(data[0]).map(([key, val]) => ({
        text: key,
        type: typeof val === 'string' ? 'string' : 'number',
      })),
      rows: data.map(d => Object.values(d).map(val => val)),
    };
  };

  // Timeseries response
  tsResponse(data: any, type: string): TimeSeries[] {
    switch (type) {
      case 'earnings': {
        const excludedFields = ['period', 'symbol'];
        const keys = Object.keys(data[0]).filter(key => !excludedFields.includes(key));
        return keys.map(key => {
          return {
            target: key,
            datapoints: data.map((dp: any) => [dp[key], new Date(dp.period).getTime()]),
          };
        });
      }
      case 'quote':
        return [
          {
            target: 'current price',
            datapoints: [[data.c, data.t * 1000]],
          },
        ];
      case 'candle':
        const fields = ['open price', 'close price'];

        return fields.map(field => ({
          target: field,
          datapoints: data.t.map((time: any, i: number) => [data[field.charAt(0)][i], time * 1000]),
        }));
      default:
        return [];
    }
  }

  async testDatasource() {
    const resp = await this.get('profile', { symbol: 'AAPL' });
    if (resp.status === 200) {
      return { status: 'success' };
    }
    return { status: 'error' };
  }

  async freeTextQuery(query: string) {
    try {
      return await this.backendSrv.get(`${this.baseUrl}/${query}&token=${this.token}`);
    } catch (e) {
      console.error('Error retrieving data', e);
    }
  }

  async get(dataType: string, params: QueryParams = {}) {
    const url = `${this.baseUrl}${dataType === 'quote' ? '' : '/stock'}`;
    try {
      return await this.backendSrv.get(`${url}/${dataType}`, {
        ...params,
        token: this.token,
      });
    } catch (e) {
      console.error('Error retrieving data', e);
      throw e;
    }
  }
}
