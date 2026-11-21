import { OrdersService } from '../src/orders/orders.service';

test('starts empty', () => {
  expect(new OrdersService().list()).toEqual([]);
});
