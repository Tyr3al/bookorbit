import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AuthorizeController } from './authorize.controller';

describe('AuthorizeController', () => {
  it('exposes GET and POST authorize routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuthorizeController)).toBe('api/authorize');
    expect(Reflect.getMetadata(METHOD_METADATA, AuthorizeController.prototype.authorize)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, AuthorizeController.prototype.authorizePost)).toBe(RequestMethod.POST);
  });
});
