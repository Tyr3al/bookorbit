import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import { AudiobookshelfAuthorizeController } from './audiobookshelf-authorize.controller';

describe('AudiobookshelfAuthorizeController', () => {
  it('exposes GET and POST authorize routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AudiobookshelfAuthorizeController)).toBe('api/authorize');
    expect(Reflect.getMetadata(METHOD_METADATA, AudiobookshelfAuthorizeController.prototype.authorize)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(METHOD_METADATA, AudiobookshelfAuthorizeController.prototype.authorizePost)).toBe(RequestMethod.POST);
  });
});
