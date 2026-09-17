import React from 'react';
import {registerRoot, Composition} from 'remotion';
import {ProductReel, defaultProductProps, calculateProductMetadata} from './ProductReel';

const Root = () => (
  <Composition
    id="ProductReel"
    component={ProductReel}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={420}
    defaultProps={defaultProductProps}
    calculateMetadata={calculateProductMetadata}
  />
);

registerRoot(Root);
